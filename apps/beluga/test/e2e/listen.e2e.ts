/**
 * Beluga end to end, without a microphone: Chromium plays a recording as the
 * capture device, the app transcribes it with the glossary and the advanced
 * settings set in the window, and the line must be on screen and in the
 * transcript file, with the glossary's terms. Glossary and settings must
 * survive a reload. A second session is run by an agent alone, over MCP: it
 * sets the glossary and a label, starts, reads the transcript by line and
 * stops. A third session is ended the way Cmd+Q ends it, in the middle of the
 * sentence, which must still reach a file of its own.
 *
 *     BELUGA_MODELS_DIR=<folder with the models> pnpm test:e2e
 *
 * Needs a display (on a headless machine: `xvfb-run -a pnpm test:e2e`) and the
 * Parakeet model. Not part of `pnpm test`: the models are a download of several
 * hundred megabytes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { toolText } from "@designiq/mcp-kit/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { _electron } from "playwright";
import sherpa from "sherpa-onnx-node";

import { missingFiles } from "../../src/engine/files.ts";

const app = fileURLToPath(new URL("../..", import.meta.url));
const modelsDir = process.env.BELUGA_MODELS_DIR;
if (!modelsDir || missingFiles(modelsDir, "parakeet-v3").length > 0) {
  console.error("Set BELUGA_MODELS_DIR to a folder that holds the Parakeet model and the detector.");
  process.exit(1);
}

/**
 * The recording Chromium plays as the microphone: a second of silence, the
 * sentence of fixtures/glossary.wav ("Die Rabattstaffel steht in der DMN Tabelle,
 * und modelliert wird das Ganze in Camunda.", which Parakeet gets wrong without
 * the glossary), three seconds of silence.
 */
function fakeMicrophone(target: string): void {
  const wav = sherpa.readWave(fileURLToPath(new URL("../fixtures/glossary.wav", import.meta.url)), false);
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

/** a port nobody uses, for the agent's endpoint: a Beluga on this machine may hold the usual one */
const freePort = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

/** the agent's key, where Beluga keeps it in its data folder */
function agentKey(dir: string): string {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === "agent-key") {
      return (JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as { key: string }).key;
    }
  }
  throw new Error("no agent key in Beluga's data folder");
}

/** a tool call as the agent makes it: the JSON answer, or a failure */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { isError, text } = toolText(await client.callTool({ name, arguments: args }));
  if (isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const electron = await _electron.launch({
  executablePath: createRequire(import.meta.url)("electron") as unknown as string,
  args: [app, "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${recording}`],
  // the app's data folder in the scratch folder too (Linux), not in the user's home
  env: {
    ...process.env,
    BELUGA_MODELS_DIR: modelsDir,
    BELUGA_FOLDER: folder,
    BELUGA_AGENT_PORT: String(freePort),
    XDG_CONFIG_HOME: join(work, "config"),
  },
  // the renderer runs sandboxed, as in the app
  chromiumSandbox: true,
});
let running = true;
try {
  const page = await electron.firstWindow();
  // a glossary with an entry Parakeet cannot write, and a longer pause under Advanced
  await page.getByLabel("Glossary", { exact: true }).fill("Rabattstaffel\nCamunda\nYılmaz");
  await page.getByText("Advanced").click();
  await page.getByLabel("Pause that ends a line").selectOption("0.8");
  await page.getByRole("button", { name: "Start listening" }).click();
  await page.getByText(/does not listen for this glossary entry: Yılmaz/).waitFor({ timeout: 60_000 });
  await page
    .getByRole("region", { name: "Transcript" })
    .getByText(/Camunda/)
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
  for (const line of lines.slice(1)) assert.match(line, /^\d{2}:\d{2}:\d{2} (Me|Others): \S/);
  const said = lines.slice(1).join("\n");
  assert.match(said, /Rabattstaffel/, "the glossary's term, not what Parakeet hears without it");
  assert.match(said, /Camunda/, "the glossary's term, not what Parakeet hears without it");
  console.log(`ok: ${lines.length - 1} line(s) in ${first}, with the glossary's terms`);

  // glossary and settings are still there after a reload
  await page.reload();
  await page.getByRole("button", { name: "Start listening" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.getByLabel("Glossary", { exact: true }).inputValue(), "Rabattstaffel\nCamunda\nYılmaz");
  await page.getByText("Advanced").click();
  assert.equal(await page.getByLabel("Pause that ends a line").inputValue(), "0.8");
  console.log("ok: glossary and settings kept");

  // an agent runs the next session on its own
  await page.getByLabel("Let an agent on this computer control Beluga").check();
  await page.getByText(`http://127.0.0.1:${freePort}/mcp`).waitFor({ timeout: 10_000 });
  const client = new Client({ name: "beluga-e2e", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${freePort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${agentKey(join(work, "config"))}` } },
    }),
  );
  const set = await call(client, "set_glossary", { entries: ["Rabattstaffel", "Camunda", "DMN"] });
  assert.deepEqual(set, { entries: 3, appliedNow: false, notListenedFor: [] });
  await call(client, "set_options", { labels: { mic: "Room" }, tuning: { pause: 0.7 } });
  // the window shows what the agent set
  await page.waitForFunction(
    (want) => (document.getElementById("glossary") as HTMLTextAreaElement | null)?.value === want,
    "Rabattstaffel\nCamunda\nDMN",
    { timeout: 10_000 },
  );
  assert.equal(await page.getByLabel("Pause that ends a line").inputValue(), "0.7", "a value between the choices");
  const started = await call(client, "start_listening");
  assert.match(started.transcript, /beluga-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.txt$/);
  assert.ok(!started.transcript.endsWith(first), "a file of its own for the agent's session");
  await page.getByText("Listening", { exact: true }).waitFor({ timeout: 10_000 });
  await assert.rejects(call(client, "set_options", { labels: { mic: "Me" } }), /Beluga is listening/);
  // read as an agent does: wait for lines until the speaker pauses
  let read = { through: 0, lines: [] as { line: number; text: string }[], phase: "listening" };
  const heard: string[] = [];
  for (const deadline = Date.now() + 60_000; !heard.some((l) => /Camunda/.test(l));) {
    assert.ok(Date.now() < deadline, `no Camunda in ${JSON.stringify(heard)}`);
    read = await call(client, "read_transcript", {
      after: read.through,
      transcript: started.transcript,
      wait: 20,
      quiet: 1,
    });
    heard.push(...read.lines.map((l) => l.text));
  }
  assert.match(heard[0] as string, /^# Beluga transcript/);
  for (const line of heard.slice(1)) assert.match(line, /^\d{2}:\d{2}:\d{2} (Room|Others): \S/);
  assert.deepEqual(await call(client, "stop_listening"), { transcript: started.transcript });
  assert.equal((await call(client, "get_status")).phase, "idle");
  const last = await call(client, "read_transcript", { after: read.through, transcript: started.transcript });
  assert.equal(last.phase, "idle", "the read says the session has stopped");
  await page.getByRole("button", { name: "Start listening" }).waitFor({ timeout: 10_000 });
  await client.close();
  console.log(`ok: an agent ran a session over MCP, ${heard.length - 1} line(s) read`);

  // quit while the sentence is being spoken (it runs from 1 s to 5.8 s of the recording)
  await page.getByRole("button", { name: "Start listening" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  const closed = electron.waitForEvent("close", { timeout: 60_000 });
  await electron.evaluate(({ app: electronApp }) => electronApp.quit());
  await closed;
  running = false;

  const second = readdirSync(folder).find((f) => f !== first && !started.transcript.endsWith(f));
  assert.ok(second, "a file of its own for the third session");
  const tail = linesOf(second);
  assert.ok(tail.length > 1, "the sentence in progress was written before the app quit");
  // the label the agent set holds for the sessions after
  for (const line of tail.slice(1)) assert.match(line, /^\d{2}:\d{2}:\d{2} (Room|Others): \S/);
  console.log(`ok: ${tail.length - 1} line(s) in ${second} after quitting`);
} finally {
  if (running) await electron.close();
  rmSync(work, { recursive: true, force: true });
}
