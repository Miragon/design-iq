/**
 * What the window and the main process say to each other. Types only: the
 * preload script exposes exactly this API as `window.beluga`.
 */
import type { Language, ModelId } from "./models.ts";
import type { Tuning } from "./settings.ts";
import type { Channel, SpeakerLabels } from "./transcript.ts";

export interface ModelInfo {
  id: ModelId;
  label: string;
  note: string;
  megabytes: number;
  installed: boolean;
}

export interface InitialState {
  models: ModelInfo[];
  model: ModelId;
  /** the folder new transcripts go to */
  folder: string;
  labels: SpeakerLabels;
  /** the processor cores of this machine, the most the recognizer may use */
  cores: number;
}

export interface StartOptions {
  model: ModelId;
  language: Language;
  labels: SpeakerLabels;
  folder: string;
  /** names and terms to listen for (Parakeet only), one entry each */
  glossary: string[];
  tuning: Tuning;
}

export interface Started {
  /** the transcript file of the session */
  path: string;
  /** glossary entries the model cannot write, so it does not listen for them */
  left: string[];
}

export interface DownloadProgress {
  model: ModelId;
  /** 0 to 1 over all files of the download */
  fraction: number;
}

/** one line as it was written to the transcript file */
export interface WrittenLine {
  channel: Channel;
  line: string;
}

export interface BelugaApi {
  init(): Promise<InitialState>;
  chooseFolder(current: string): Promise<string | null>;
  installModel(model: ModelId): Promise<void>;
  /** the entries of a glossary file the facilitator picks: a workshop brief or a plain list; null when none was picked */
  importGlossary(): Promise<string[] | null>;
  /** begins a session and answers where its transcript goes */
  start(options: StartOptions): Promise<Started>;
  /** ends the session once the engine has transcribed what it still holds */
  stop(): Promise<void>;
  /** 16 kHz mono samples of one channel, `at` the time the last one was captured */
  audio(channel: Channel, samples: Float32Array, at: number): void;
  showFile(path: string): void;
  onLine(listener: (line: WrittenLine) => void): () => void;
  onDownload(listener: (progress: DownloadProgress) => void): () => void;
  /** how many seconds the transcript runs behind the conversation, while the engine catches up */
  onLag(listener: (seconds: number) => void): () => void;
  /** the session ended without the page asking: the engine failed or the file cannot be written */
  onSessionEnded(listener: (message: string) => void): () => void;
  /** the app is quitting: the session stops listening and finishes what it heard */
  onFinishing(listener: () => void): () => void;
}

/** messages into the engine process */
export type EngineRequest =
  | { type: "start"; modelsDir: string; model: ModelId; language: Language; glossary: string[]; tuning: Tuning }
  | { type: "audio"; channel: Channel; samples: Float32Array; at: number }
  | { type: "stop" };

/** messages out of the engine process */
export type EngineReply =
  /** the model runs; `left` are the glossary entries it cannot write */
  | { type: "ready"; left: string[] }
  | { type: "utterance"; channel: Channel; startedAt: number; text: string }
  /**
   * every second while a session runs: the engine is through with the audio
   * captured up to `at` (null before the first piece)
   */
  | { type: "progress"; at: number | null }
  | { type: "stopped" }
  | { type: "error"; message: string };
