/**
 * The engine on real audio. Needs the model files, which are not in the repo:
 * set BELUGA_MODELS_DIR to a folder that holds them (the app's own models folder
 * will do) and the test runs; without it the test is skipped.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import sherpa from "sherpa-onnx-node";

import { modelSpec } from "../src/core/models.ts";
import type { Utterance } from "../src/core/transcript.ts";
import { missingFiles } from "../src/engine/files.ts";
import { MAX_UTTERANCE_SECONDS, SAMPLE_RATE, SherpaEngine } from "../src/engine/sherpa.ts";

const modelsDir = process.env.BELUGA_MODELS_DIR;
const ready = modelsDir !== undefined && missingFiles(modelsDir, "parakeet-v3").length === 0;

/** linear resampling: enough to turn the 22.05 kHz sample into the 16 kHz the engine takes */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const pos = (i * from) / to;
    const left = Math.floor(pos);
    const a = samples[left] ?? 0;
    const b = samples[left + 1] ?? a;
    out[i] = a + (b - a) * (pos - left);
  }
  return out;
}

/** the German sample, at the engine's rate */
function sentence(dir: string): Float32Array {
  const wav = sherpa.readWave(join(dir, modelSpec("parakeet-v3").dir, "test_wavs", "de.wav"), false);
  return resample(wav.samples, wav.sampleRate, SAMPLE_RATE);
}

/** two people talking over each other: the sentence on a loop, and again 0.7 s later, for `seconds` */
function overlap(speech: Float32Array, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const stagger = Math.round(0.7 * SAMPLE_RATE);
  for (let i = 0; i < out.length; i++) {
    const a = speech[i % speech.length] as number;
    const b = i >= stagger ? (speech[(i - stagger) % speech.length] as number) : 0;
    out[i] = 0.6 * a + 0.6 * b;
  }
  return out;
}

type Feed = (channel: "mic" | "system", samples: Float32Array) => Promise<void>;

/** an engine fed the way the app feeds it: pieces of 100 ms, each stamped with the time it was captured */
function engineAt(dir: string, start: number): { heard: Utterance[]; engine: SherpaEngine; feed: Feed } {
  const heard: Utterance[] = [];
  const engine = new SherpaEngine({ modelsDir: dir, model: "parakeet-v3" }, (u) => heard.push(u));
  let clock = start;
  const feed: Feed = async (channel, samples) => {
    for (let i = 0; i < samples.length; i += 1600) {
      clock += 100;
      await engine.push(channel, samples.subarray(i, i + 1600), clock);
    }
  };
  return { heard, engine, feed };
}

const seconds = (from: number, to: number): number => (to - from) / 1000;

test("a German sentence on each channel comes out as one utterance each", { skip: !ready }, async () => {
  const dir = modelsDir as string;
  const speech = sentence(dir);
  const silence = new Float32Array(SAMPLE_RATE);
  const start = new Date(2026, 10, 21, 14, 30, 0).getTime();
  const { heard, engine, feed } = engineAt(dir, start);

  await feed("mic", silence);
  await feed("mic", speech);
  await feed("mic", silence);
  await feed("system", speech);
  await engine.flush();

  assert.deepEqual(
    heard.map((u) => u.channel),
    ["mic", "system"],
  );
  for (const u of heard) assert.match(u.text, /Alles hat ein Ende/);
  // the mic utterance began after the leading second of silence, not at the session start
  const micOffset = (heard[0] as Utterance).startedAt - start;
  assert.ok(micOffset > 500 && micOffset < 2000, `mic utterance at ${micOffset} ms`);
});

test("talk without a pause is cut at the limit", { skip: !ready }, async () => {
  const dir = modelsDir as string;
  // two people over each other for 50 s: the detector alone would let this run past 30 s
  const talk = overlap(sentence(dir), 50);
  const start = new Date(2026, 10, 21, 14, 30, 0).getTime();
  const { heard, engine, feed } = engineAt(dir, start);

  await feed("mic", talk);
  await engine.flush();

  const starts = heard.map((u) => u.startedAt);
  const lengths = starts.map((at, i) => seconds(at, starts[i + 1] ?? start + talk.length / 16));
  assert.ok(heard.length >= 3, `${heard.length} utterances`);
  for (const length of lengths) assert.ok(length <= MAX_UTTERANCE_SECONDS + 0.5, `an utterance of ${length} s`);
  assert.ok(
    lengths.some((length) => length >= MAX_UTTERANCE_SECONDS - 0.5),
    `the limit cut nothing: ${lengths.join(", ")} s`,
  );
  // two voices at once come out garbled, but every cut piece is transcribed
  for (const u of heard) assert.ok(u.text.length > 20, u.text);
});

test("talk that ends just before the limit leaves no empty utterance behind", { skip: !ready }, async () => {
  const dir = modelsDir as string;
  const speech = sentence(dir);
  const silence = new Float32Array(SAMPLE_RATE * 2);
  const { heard, engine, feed } = engineAt(dir, new Date(2026, 10, 21, 14, 30, 0).getTime());

  // around the moment the limit cuts, the detector can hand out an empty piece,
  // and decoding that brought the whole process down
  for (let tenths = 195; tenths <= 205; tenths++) {
    await feed("mic", silence);
    await feed("mic", overlap(speech, tenths / 10));
  }
  await feed("mic", silence);
  await engine.flush();

  assert.ok(heard.length >= 11, `${heard.length} utterances`);
  for (const u of heard) assert.ok(u.text.length > 0);
});
