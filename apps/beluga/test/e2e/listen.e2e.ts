/**
 * Beluga end to end, without a microphone: Chromium plays a recording as the
 * capture device, the app transcribes it, and the line must be on screen and in
 * the transcript file. A second session is ended the way Cmd+Q ends it, in the
 * middle of the sentence, which must still reach a file of its own.
 *
 *     BELUGA_MODELS_DIR=<folder with the models> pnpm test:e2e
 *
 * Needs a display (on a headless machine: `xvfb-run -a pnpm test:e2e`) and the
 * Parakeet model, whose archive brings the German sample this test plays. Not
 * part of `pnpm test`: the models are a download of several hundred megabytes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron } from "playwright";
import sherpa from "sherpa-onnx-node";

import { modelSpec } from "../../src/core/models.ts";
import { missingFiles } from "../../src/engine/files.ts";

const app = fileURLToPath(new URL("../..", import.meta.url));
const modelsDir = process.env.BELUGA_MODELS_DIR;
if (!modelsDir || missingFiles(modelsDir, "parakeet-v3").length > 0) {
  console.error("Set BELUGA_MODELS_DIR to a folder that holds the Parakeet model and the detector.");
  process.exit(1);
}

/** the recording Chromium plays as the microphone: a second of silence, the sentence, three seconds of silence */
function fakeMicrophone(target: string): void {
  const wav = sherpa.readWave(join(modelsDir as string, modelSpec("parakeet-v3").dir, "test_wavs", "de.wav"), false);
  const rate = wav.sampleRate;
  const samples = new Float32Array(rate + wav.samples.length + rate * 3);
  samples.set(wav.samples, rate);
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  writeFileSync(target, out);
}

const work = mkdtempSync(join(tmpdir(), "beluga-e2e-"));
const folder = join(work, "transcripts");
const recording = join(work, "mic.wav");
fakeMicrophone(recording);

const linesOf = (file: string): string[] => readFileSync(join(folder, file), "utf8").trimEnd().split("\n");

const electron = await _electron.launch({
  executablePath: createRequire(import.meta.url)("electron") as unknown as string,
  args: [app, "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${recording}`],
  // the app's data folder in the scratch folder too (Linux), not in the user's home
  env: { ...process.env, BELUGA_MODELS_DIR: modelsDir, BELUGA_FOLDER: folder, XDG_CONFIG_HOME: join(work, "config") },
  // the renderer runs sandboxed, as in the app
  chromiumSandbox: true,
});
let running = true;
try {
  const page = await electron.firstWindow();
  await page.getByRole("button", { name: "Start listening" }).click();
  await page
    .getByText(/Alles hat ein Ende/)
    .first()
    .waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Start listening" }).waitFor({ timeout: 30_000 });

  const files = readdirSync(folder);
  assert.equal(files.length, 1, "one transcript file per session");
  const first = files[0] as string;
  const lines = linesOf(first);
  assert.match(lines[0] as string, /^# Beluga transcript, started \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(lines.length > 1, "the sentence was written");
  for (const line of lines.slice(1)) assert.match(line, /^\d{2}:\d{2}:\d{2} (Me|Others): .*Alles hat ein Ende/);
  console.log(`ok: ${lines.length - 1} line(s) in ${first}`);

  // quit while the sentence is being spoken (it runs from 1 s to 3.75 s of the recording)
  await page.getByRole("button", { name: "Start listening" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  const closed = electron.waitForEvent("close", { timeout: 60_000 });
  await electron.evaluate(({ app: electronApp }) => electronApp.quit());
  await closed;
  running = false;

  const second = readdirSync(folder).find((f) => f !== first);
  assert.ok(second, "a file of its own for the second session");
  const tail = linesOf(second);
  assert.ok(tail.length > 1, "the sentence in progress was written before the app quit");
  for (const line of tail.slice(1)) assert.match(line, /^\d{2}:\d{2}:\d{2} (Me|Others): \S/);
  console.log(`ok: ${tail.length - 1} line(s) in ${second} after quitting`);
} finally {
  if (running) await electron.close();
  rmSync(work, { recursive: true, force: true });
}
