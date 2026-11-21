// sherpa-onnx-node ships JSDoc only. These are the parts Beluga calls, typed
// from its types.js (2.0.2).
//
// The package is CommonJS: under Node's ESM loader only its default export
// carries the values. So the classes are declared as types here and reachable as
// values only through the default export; `import { Vad } from "sherpa-onnx-node"`
// used as a value does not typecheck, as it would not run under Node either.
declare module "sherpa-onnx-node" {
  export interface SpeechSegment {
    /** sample position of the segment's start in everything fed so far */
    start: number;
    samples: Float32Array;
  }
  export interface VadConfig {
    sileroVad: {
      model: string;
      threshold?: number;
      minSilenceDuration?: number;
      minSpeechDuration?: number;
      windowSize?: number;
      maxSpeechDuration?: number;
    };
    sampleRate: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }
  export interface Vad {
    /** any length: the detector keeps what does not fill a frame for the next call or flush() */
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    /** whether the detector is inside speech right now */
    isDetected(): boolean;
    pop(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    /** ends the speech in progress as a segment, whatever its length */
    flush(): void;
    reset(): void;
  }
  export interface OfflineModelConfig {
    transducer?: { encoder: string; decoder: string; joiner: string };
    whisper?: { encoder: string; decoder: string; language?: string; task?: string; tailPaddings?: number };
    tokens: string;
    modelType?: string;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }
  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: OfflineModelConfig;
    decodingMethod?: string;
  }
  export interface OfflineStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
    /** a decoding option for this stream only, such as Whisper's `max_tokens_per_second` */
    setOption(key: string, value: string): void;
  }
  export interface OfflineRecognizer {
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    /** decodes on a worker thread, the event loop stays free */
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
    getResult(stream: OfflineStream): { text: string };
  }
  export interface Wave {
    samples: Float32Array;
    sampleRate: number;
  }
  const sherpa: {
    Vad: new (config: VadConfig, bufferSizeInSeconds: number) => Vad;
    OfflineRecognizer: new (config: OfflineRecognizerConfig) => OfflineRecognizer;
    readWave(path: string, enableExternalBuffer?: boolean): Wave;
  };
  export default sherpa;
}
