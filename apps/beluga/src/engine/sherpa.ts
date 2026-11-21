/**
 * The speech engine: audio in, utterances out. Each channel has its own voice
 * activity detector, which cuts the stream at pauses; every cut piece is
 * transcribed on its own. Silence never reaches the recognizer, so there is
 * nothing for a model to make up during a pause.
 *
 * This is the one module that knows sherpa-onnx. Another runtime (whisper.cpp, a
 * hosted service) is another class with the `Engine` interface below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import sherpa, { type OfflineRecognizer, type OfflineRecognizerConfig, type Vad } from "sherpa-onnx-node";

import { type Language, type ModelId, modelSpec, VAD } from "../core/models.ts";
import { DEFAULT_TUNING, type Tuning } from "../core/settings.ts";
import type { Channel, Utterance } from "../core/transcript.ts";
import { SampleClock } from "./clock.ts";
import { missingFiles } from "./files.ts";
import { hotwords, PieceEncoder } from "./hotwords.ts";

/** every stage works on 16 kHz mono float samples */
export const SAMPLE_RATE = 16000;
/**
 * The detector's frame at 16 kHz. It takes pieces of any length, but then
 * places the start of an utterance 64 ms late (sherpa-onnx 2.0.2), which cuts off
 * the first sound of a word: it gets whole frames, and the rest waits for the next piece.
 */
const VAD_FRAME = 512;
/**
 * Shorter than this is no utterance: the detector can hand out an empty piece
 * right after a cut, and decoding nothing brings the recognizer down.
 */
const MIN_SEGMENT = SAMPLE_RATE / 10;
/**
 * Whisper stops after 6 tokens per second of audio by default, which fast German
 * speech exceeds: the end of such a line went missing.
 */
const WHISPER_TOKENS_PER_SECOND = "10";
/** the hypotheses Parakeet follows at once while it decodes with a glossary */
const GLOSSARY_PATHS = 4;

export interface EngineConfig {
  /** the models folder, which holds each model's folder and the detector */
  modelsDir: string;
  model: ModelId;
  language?: Language;
  /** names and terms to listen for; Parakeet takes them, Whisper does not here */
  glossary?: readonly string[];
  /** what the facilitator tuned; the rest is the default */
  tuning?: Partial<Tuning>;
}

/**
 * One call at a time: wait for a push to settle before the next. Transcribing
 * runs off the caller's thread, so the caller stays free in between.
 */
export interface Engine {
  /** the glossary entries this engine does not listen for */
  readonly left: readonly string[];
  /**
   * feed audio of one channel: 16 kHz mono, any length, `at` the time its last
   * sample was captured (milliseconds since the epoch)
   */
  push(channel: Channel, samples: Float32Array, at: number): Promise<void>;
  /** transcribe what is still buffered, at the end of a session */
  flush(): Promise<void>;
}

/** `withGlossary`: decode with a beam, which a glossary needs; without one, greedy is as good and quicker */
function recognizerConfig(config: EngineConfig, tuning: Tuning, withGlossary: boolean): OfflineRecognizerConfig {
  const spec = modelSpec(config.model);
  const at = (file: string): string => join(config.modelsDir, spec.dir, file);
  const common = { numThreads: tuning.threads, provider: "cpu", debug: 0 };
  const featConfig = { sampleRate: SAMPLE_RATE, featureDim: 80 };
  switch (config.model) {
    case "parakeet-v3":
      return {
        featConfig,
        modelConfig: {
          transducer: {
            encoder: at("encoder.int8.onnx"),
            decoder: at("decoder.int8.onnx"),
            joiner: at("joiner.int8.onnx"),
          },
          tokens: at("tokens.txt"),
          modelType: "nemo_transducer",
          ...common,
        },
        ...(withGlossary
          ? {
              decodingMethod: "modified_beam_search",
              maxActivePaths: GLOSSARY_PATHS,
              hotwordsScore: tuning.glossaryWeight,
            }
          : {}),
      };
    case "whisper-turbo": {
      const language = config.language && config.language !== "auto" ? config.language : "";
      return {
        featConfig,
        modelConfig: {
          whisper: {
            encoder: at("turbo-encoder.int8.onnx"),
            decoder: at("turbo-decoder.int8.onnx"),
            language,
            task: "transcribe",
          },
          tokens: at("turbo-tokens.txt"),
          ...common,
        },
      };
    }
  }
}

interface ChannelState {
  vad: Vad;
  /** samples that do not fill a frame yet */
  pending: Float32Array;
  clock: SampleClock;
  /** whether any audio of this channel arrived */
  heard: boolean;
  /** samples since the detector found speech, to cut an utterance without a pause */
  speech: number;
}

export class SherpaEngine implements Engine {
  readonly left: readonly string[];
  readonly #recognizer: OfflineRecognizer;
  /** the glossary as sherpa-onnx takes it for a stream; empty without one */
  readonly #hotwords: string;
  readonly #channels: Record<Channel, ChannelState>;
  readonly #onUtterance: (utterance: Utterance) => void;
  readonly #whisper: boolean;
  /**
   * The longest utterance in samples: someone who talks this long without a
   * pause is cut here. The detector alone does not cut (its own limit only
   * makes it look harder for a short pause).
   */
  readonly #longest: number;

  constructor(config: EngineConfig, onUtterance: (utterance: Utterance) => void) {
    const missing = missingFiles(config.modelsDir, config.model);
    if (missing.length > 0) throw new Error(`model files missing in ${config.modelsDir}: ${missing.join(", ")}`);
    const tuning: Tuning = { ...DEFAULT_TUNING, ...config.tuning };
    this.#longest = tuning.longestLine * SAMPLE_RATE;
    const glossary = config.glossary ?? [];
    if (config.model === "parakeet-v3" && glossary.length > 0) {
      const tokens = readFileSync(join(config.modelsDir, modelSpec(config.model).dir, "tokens.txt"), "utf8");
      const heard = hotwords(glossary, new PieceEncoder(tokens));
      this.#hotwords = heard.text;
      this.left = heard.left;
    } else {
      this.#hotwords = "";
      this.left = [...glossary];
    }
    this.#recognizer = new sherpa.OfflineRecognizer(recognizerConfig(config, tuning, this.#hotwords !== ""));
    this.#onUtterance = onUtterance;
    this.#whisper = config.model === "whisper-turbo";
    const channel = (): ChannelState => ({
      vad: new sherpa.Vad(
        {
          sileroVad: {
            model: join(config.modelsDir, VAD.file.name),
            threshold: tuning.speechThreshold,
            // a pause this long ends an utterance
            minSilenceDuration: tuning.pause,
            minSpeechDuration: 0.25,
            windowSize: VAD_FRAME,
            // from here on the detector takes a shorter pause as the end
            maxSpeechDuration: tuning.longestLine * 0.75,
          },
          sampleRate: SAMPLE_RATE,
          numThreads: 1,
          debug: 0,
        },
        60,
      ),
      pending: new Float32Array(0),
      clock: new SampleClock(SAMPLE_RATE),
      heard: false,
      speech: 0,
    });
    this.#channels = { mic: channel(), system: channel() };
  }

  async push(channel: Channel, samples: Float32Array, at: number): Promise<void> {
    const state = this.#channels[channel];
    state.heard = true;
    state.clock.piece(samples.length, at);
    let buffer = samples;
    if (state.pending.length > 0) {
      buffer = new Float32Array(state.pending.length + samples.length);
      buffer.set(state.pending);
      buffer.set(samples, state.pending.length);
    }
    let offset = 0;
    for (; offset + VAD_FRAME <= buffer.length; offset += VAD_FRAME) {
      state.vad.acceptWaveform(buffer.subarray(offset, offset + VAD_FRAME));
    }
    state.pending = buffer.slice(offset);
    state.speech = state.vad.isDetected() ? state.speech + samples.length : 0;
    if (state.speech >= this.#longest) {
      // no pause in sight: end the utterance here, the next one begins with the next sample
      state.vad.flush();
      state.speech = 0;
    }
    await this.#drain(channel);
  }

  async flush(): Promise<void> {
    for (const channel of ["mic", "system"] as const) {
      const state = this.#channels[channel];
      if (!state.heard) continue;
      // the last part of a frame belongs to the last utterance
      if (state.pending.length > 0) state.vad.acceptWaveform(state.pending);
      state.pending = new Float32Array(0);
      state.vad.flush();
      await this.#drain(channel);
    }
  }

  async #drain(channel: Channel): Promise<void> {
    const state = this.#channels[channel];
    while (!state.vad.isEmpty()) {
      // false: copy the samples out, the detector frees its own on pop()
      const segment = state.vad.front(false);
      state.vad.pop();
      state.speech = 0;
      if (segment.samples.length < MIN_SEGMENT) continue;
      const stream = this.#hotwords ? this.#recognizer.createStream(this.#hotwords) : this.#recognizer.createStream();
      if (this.#whisper) stream.setOption("max_tokens_per_second", WHISPER_TOKENS_PER_SECOND);
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: segment.samples });
      const text = (await this.#recognizer.decodeAsync(stream)).text.trim();
      if (!text) continue;
      this.#onUtterance({ channel, startedAt: state.clock.timeOf(segment.start), text });
    }
  }
}
