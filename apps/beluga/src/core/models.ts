/**
 * The speech models Beluga can run, all open weights, all local. Their files are
 * downloaded on first use, one by one, from the model repositories of the
 * sherpa-onnx project at a fixed revision, checked against their SHA-256 and kept
 * in the app's data folder; nothing is bundled with the app. The detector comes
 * from a sherpa-onnx release, where a file keeps its name when it is replaced: the
 * checksum then refuses the new one, and its entry here needs updating.
 */

export type ModelId = "parakeet-v3" | "whisper-turbo";

export interface ModelFile {
  /** the path inside the model's folder, which is also its path in the repository */
  name: string;
  bytes: number;
  sha256: string;
}

export interface ModelSpec {
  id: ModelId;
  label: string;
  /** one line for the model picker */
  note: string;
  /** the repository the files come from, at a fixed revision */
  source: string;
  /** the model's folder under the models folder */
  dir: string;
  files: readonly ModelFile[];
}

/** a file of a Hugging Face repository at one revision, which never changes */
const huggingFace = (repo: string, revision: string): string => `https://huggingface.co/${repo}/resolve/${revision}`;

export const MODELS: readonly ModelSpec[] = [
  {
    id: "parakeet-v3",
    label: "Parakeet v3",
    note: "Fast, 25 European languages. The default.",
    source: huggingFace(
      "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
      "ed5d745623472f97cfc2e6c2916ee248798fc5a8",
    ),
    dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    files: [
      {
        name: "encoder.int8.onnx",
        bytes: 652282294,
        sha256: "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479",
      },
      {
        name: "decoder.int8.onnx",
        bytes: 11845274,
        sha256: "0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5",
      },
      {
        name: "joiner.int8.onnx",
        bytes: 6355277,
        sha256: "cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98",
      },
      {
        name: "tokens.txt",
        bytes: 93939,
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
      },
      // a German sentence, 120 KB: the engine test and the end-to-end test play it
      {
        name: "test_wavs/de.wav",
        bytes: 121388,
        sha256: "36d3c4845b9808a1656a2a2e92d884590e2db94389e6fe559643291ae0cd3710",
      },
    ],
  },
  {
    id: "whisper-turbo",
    label: "Whisper large-v3-turbo",
    note: "99 languages, about ten times slower on a CPU: two busy channels can leave it behind.",
    source: huggingFace("csukuangfj/sherpa-onnx-whisper-turbo", "2ca6ff69fc878651b770880507669577ac41c2ff"),
    dir: "sherpa-onnx-whisper-turbo",
    files: [
      {
        name: "turbo-encoder.int8.onnx",
        bytes: 674716297,
        sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b",
      },
      {
        name: "turbo-decoder.int8.onnx",
        bytes: 361080764,
        sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547",
      },
      {
        name: "turbo-tokens.txt",
        bytes: 816730,
        sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
      },
    ],
  },
];

/** the voice activity detector every model needs: it cuts the audio at pauses */
export const VAD = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  file: {
    name: "silero_vad.onnx",
    bytes: 643854,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
  } satisfies ModelFile,
} as const;

export const DEFAULT_MODEL: ModelId = "parakeet-v3";

export function modelSpec(id: ModelId): ModelSpec {
  const spec = MODELS.find((m) => m.id === id);
  if (!spec) throw new Error(`unknown model ${id}`);
  return spec;
}

/** one file a model needs: where it goes under the models folder and where it comes from */
export interface Download {
  file: ModelFile;
  /** relative to the models folder, `/`-separated */
  path: string;
  url: string;
}

/** every file a model needs, the detector included */
export function downloads(id: ModelId): Download[] {
  const spec = modelSpec(id);
  return [
    { file: VAD.file, path: VAD.file.name, url: VAD.url },
    ...spec.files.map((file) => ({ file, path: `${spec.dir}/${file.name}`, url: `${spec.source}/${file.name}` })),
  ];
}

/** the download size of a model in megabytes, for the picker */
export function megabytes(id: ModelId): number {
  return Math.round(downloads(id).reduce((sum, d) => sum + d.file.bytes, 0) / 1e6);
}

/** the language a Whisper model is told to expect; Parakeet detects it itself */
export type Language = "de" | "en" | "auto";
