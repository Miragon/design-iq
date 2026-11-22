/**
 * The engine on real audio. Needs the model files, which are not in the repo:
 * set BELUGA_MODELS_DIR to a folder that holds them (the app's own models folder
 * will do) and the test runs; without it the test is skipped.
 *
 * fixtures/glossary.wav is a sentence spoken by Piper with the Thorsten voice
 * (dataset CC0): "Die Rabattstaffel steht in der DMN Tabelle, und modelliert
 * wird das Ganze in Camunda."
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import sherpa from "sherpa-onnx-node";

import { modelSpec } from "../src/core/models.ts";
import { DEFAULT_TUNING, type Tuning } from "../src/core/settings.ts";
import type { Utterance } from "../src/core/transcript.ts";
import { missingFiles } from "../src/engine/files.ts";
import { SAMPLE_RATE, SherpaEngine } from "../src/engine/sherpa.ts";

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

/** a recording at the engine's rate */
function recording(path: string): Float32Array {
  const wav = sherpa.readWave(path, false);
  return resample(wav.samples, wav.sampleRate, SAMPLE_RATE);
}

/** the German sample that comes with the model */
const sentence = (dir: string): Float32Array =>
  recording(join(dir, modelSpec("parakeet-v3").dir, "test_wavs", "de.wav"));

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
function engineAt(
  dir: string,
  start: number,
  glossary: string[] = [],
  tuning: Partial<Tuning> = {},
): { heard: Utterance[]; engine: SherpaEngine; feed: Feed } {
  const heard: Utterance[] = [];
  const engine = new SherpaEngine({ modelsDir: dir, model: "parakeet-v3", glossary, tuning }, (u) => heard.push(u));
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

for (const longest of [DEFAULT_TUNING.longestLine, 10]) {
  test(`talk without a pause is cut at the limit (${longest} s)`, { skip: !ready }, async () => {
    const dir = modelsDir as string;
    // two people over each other for 50 s: the detector alone would let this run past 30 s
    const talk = overlap(sentence(dir), 50);
    const start = new Date(2026, 10, 21, 14, 30, 0).getTime();
    const { heard, engine, feed } = engineAt(dir, start, [], { longestLine: longest });

    await feed("mic", talk);
    await engine.flush();

    const starts = heard.map((u) => u.startedAt);
    const lengths = starts.map((at, i) => seconds(at, starts[i + 1] ?? start + talk.length / 16));
    assert.ok(heard.length >= 50 / longest, `${heard.length} utterances`);
    for (const length of lengths) assert.ok(length <= longest + 0.5, `an utterance of ${length} s`);
    assert.ok(
      lengths.some((length) => length >= longest - 0.5),
      `the limit cut nothing: ${lengths.join(", ")} s`,
    );
    // two voices at once come out garbled, but every cut piece is transcribed
    for (const u of heard) assert.ok(u.text.length > 20, u.text);
  });
}

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

/** what the engine makes of one recording on the microphone, with a glossary or without */
async function transcribe(dir: string, speech: Float32Array, glossary: string[] = []): Promise<string> {
  const { heard, engine, feed } = engineAt(dir, new Date(2026, 10, 21, 14, 30, 0).getTime(), glossary);
  await feed("mic", speech);
  await feed("mic", new Float32Array(SAMPLE_RATE));
  await engine.flush();
  return heard.map((u) => u.text).join(" ");
}

test("the glossary brings names and terms the model does not know", { skip: !ready }, async () => {
  const dir = modelsDir as string;
  const speech = recording(join(import.meta.dirname, "fixtures", "glossary.wav"));

  // without it, Parakeet writes what it heard: "Rabatstafel", "Kamunda"
  const plain = await transcribe(dir, speech);
  assert.doesNotMatch(plain, /Rabattstaffel|Camunda/, plain);

  const text = await transcribe(dir, speech, ["Rabattstaffel", "DMN", "Camunda", "Anna Wiśniewski"]);
  assert.match(text, /Rabattstaffel/, text);
  assert.match(text, /\bDMN\b/, text);
  assert.match(text, /Camunda/, text);
});

test("a long glossary puts nothing into a sentence that holds none of it", { skip: !ready }, async () => {
  const dir = modelsDir as string;
  // names that sound like the words of the sentence: "Zweig" took the place of
  // "zwei" when the glossary weighed more
  const names = ["Müller", "Schmidt", "Wurstmann", "Ende", "Allesandro", "Hattinger", "Zweig", "Nurmi"];
  const terms = ["Rabattstaffel", "Camunda", "Domain Event", "Event Storming", "Kreditorenbuchhaltung"];
  const glossary = [...names, ...terms, ...names.flatMap((n) => terms.map((t) => `${t} ${n}`))];

  const text = await transcribe(dir, sentence(dir), glossary);
  assert.equal(text, "Alles hat ein Ende, nur die Wurst hat zwei.");
});

test("entries the model cannot write are left out, and said so", { skip: !ready }, () => {
  const engine = new SherpaEngine(
    { modelsDir: modelsDir as string, model: "parakeet-v3", glossary: ["Camunda", "S/4HANA", "Yılmaz", "ISO 9001"] },
    () => undefined,
  );
  assert.deepEqual(engine.left, ["S/4HANA", "Yılmaz", "ISO 9001"]);
});

test("a glossary given while listening counts from the next utterance on", { skip: !ready }, async () => {
  const dir = modelsDir as string;
  const speech = recording(join(import.meta.dirname, "fixtures", "glossary.wav"));
  const { heard, engine, feed } = engineAt(dir, new Date(2026, 10, 21, 14, 30, 0).getTime());

  await feed("mic", speech);
  await feed("mic", new Float32Array(SAMPLE_RATE));
  engine.setGlossary(["Rabattstaffel", "Camunda", "Yılmaz"]);
  assert.deepEqual(engine.left, ["Yılmaz"]);
  await feed("mic", speech);
  await engine.flush();

  const [before, ...later] = heard.map((u) => u.text);
  assert.doesNotMatch(before ?? "", /Camunda/, before ?? "nothing");
  assert.match(later.join(" "), /Rabattstaffel.*Camunda/, later.join(" "));
});

test("with a glossary, two people at once still come out as text", { skip: !ready }, async () => {
  const dir = modelsDir as string;
  // beam search returned nothing for this without the penalty on the blank
  for (const seconds of [3, 10]) {
    const text = await transcribe(dir, overlap(sentence(dir), seconds), ["Camunda", "Rabattstaffel"]);
    assert.ok(text.length > 10, `${seconds} s: "${text}"`);
  }
});
