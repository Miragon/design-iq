/**
 * The agent's way into Beluga: what its tools do (against a stand-in for the
 * main process) and who gets through the endpoint (over real HTTP).
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { toolNamesIn, toolText } from "@designiq/mcp-kit/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { type ControlDeps, createControl } from "../src/agent/control.ts";
import { type AgentEndpoint, openAgentEndpoint } from "../src/agent/endpoint.ts";
import { INSTRUCTIONS } from "../src/agent/server.ts";
import type { RemoteResult } from "../src/core/ipc.ts";
import { defaultPreferences, type Preferences } from "../src/core/preferences.ts";
import { DEFAULT_TUNING } from "../src/core/settings.ts";

const KEY = "k".repeat(43);
const work = mkdtempSync(join(tmpdir(), "beluga-agent-"));
const transcript = join(work, "beluga-2026-11-21-1430.txt");

/** the main process as the tools see it, with a record of what they asked it to do; a start writes to `file` */
function standIn(file = transcript): {
  deps: ControlDeps;
  asked: string[];
  prefs: () => Preferences;
  set: (p: ControlDeps["phase"]) => void;
  /** a new session's file, as the main process names it once that session runs */
  move: (to: string) => void;
} {
  let prefs = defaultPreferences(work);
  let phase: ReturnType<ControlDeps["phase"]> = "idle";
  let path: string | null = null;
  const asked: string[] = [];
  const deps: ControlDeps = {
    preferences: () => prefs,
    updatePreferences: (change) => {
      prefs = { ...prefs, ...change };
    },
    phase: () => phase,
    transcriptPath: () => path,
    behind: () => 2,
    installed: (model) => model === "parakeet-v3",
    notListenedFor: (_model, entries) => entries.filter((e) => /\d/.test(e)),
    glossaryToSession: (entries) =>
      Promise.resolve(phase === "listening" ? entries.filter((e) => e.includes("ı")) : null),
    sessionLeft: () => (phase === "listening" ? [] : null),
    remote: (action): Promise<RemoteResult> => {
      asked.push(action);
      if (action === "start") {
        phase = "listening";
        path = file;
        return Promise.resolve({ ok: true, channels: ["mic"], notice: null });
      }
      phase = "idle";
      return Promise.resolve({ ok: true, channels: [], notice: null });
    },
    whenStopped: () => Promise.resolve(),
  };
  return { deps, asked, prefs: () => prefs, set: (p) => (phase = p()), move: (to) => (path = to) };
}

test("the glossary is replaced or added to, and a running session gets it at once", async () => {
  const { deps, prefs, set } = standIn();
  const control = createControl(deps);
  assert.deepEqual(await control.setGlossary(["Camunda", " Camunda ", "ISO 9001"], "replace"), {
    entries: 2,
    appliedNow: false,
    notListenedFor: ["ISO 9001"],
  });
  await control.setGlossary(["Rabattstaffel"], "add");
  assert.equal(prefs().glossary, "Camunda\nISO 9001\nRabattstaffel");
  set(() => "listening");
  assert.deepEqual(await control.setGlossary(["Yılmaz"], "add"), {
    entries: 4,
    appliedNow: true,
    notListenedFor: ["Yılmaz"],
  });
});

test("options are checked like the window's, and only what is given changes", async () => {
  const { deps, prefs } = standIn();
  const control = createControl(deps);
  const status = await control.setOptions({ systemAudio: false, labels: { system: "Room" }, tuning: { pause: 0.8 } });
  assert.equal(status.systemAudio, false);
  assert.deepEqual(prefs().labels, { mic: "Me", system: "Room" });
  assert.deepEqual(prefs().settings.tuning, { ...DEFAULT_TUNING, pause: 0.8 });
  await assert.rejects(control.setOptions({ tuning: { longestLine: 60 } }), /longestLine is out of range/);
  await assert.rejects(control.setOptions({ labels: { mic: "x".repeat(41) } }), /at most 40 characters/);
  assert.deepEqual(prefs().settings.tuning, { ...DEFAULT_TUNING, pause: 0.8 }, "a refused change changes nothing");
});

test("a session keeps the options it started with, and the glossary can still change", async () => {
  const { deps, prefs, set } = standIn();
  const control = createControl(deps);
  for (const phase of ["starting", "listening", "stopping"] as const) {
    set(() => phase);
    await assert.rejects(control.setOptions({ tuning: { pause: 0.8 } }), new RegExp(`Beluga is ${phase}`));
  }
  assert.deepEqual(prefs().settings.tuning, DEFAULT_TUNING);
  assert.equal((await control.setGlossary(["Camunda"], "add")).appliedNow, false, "stopping: for the next session");
  set(() => "starting");
  assert.equal(
    (await control.setGlossary(["DMN"], "add")).appliedNow,
    true,
    "starting: the session takes it once it runs",
  );
});

/** how long a promise takes, in milliseconds */
async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const began = Date.now();
  const value = await work;
  return { value, ms: Date.now() - began };
}

test("a waiting read answers once the conversation pauses, with every line that came", async () => {
  const file = join(work, "waiting.txt");
  writeFileSync(file, "# Beluga transcript, started 2026-11-21 14:30\n");
  const { deps, set, move } = standIn(file);
  const control = createControl(deps);
  await control.start();

  const reading = timed(control.readTranscript(1, 200, 5, 0.5));
  await sleep(100);
  appendFileSync(file, "14:30:05 Room: Erst kommt die Bestellung.\n");
  await sleep(300);
  appendFileSync(file, "14:30:08 Room: Dann die Bonitätsprüfung.\n");
  const { value, ms } = await reading;
  assert.deepEqual(
    value.lines.map((l) => l.line),
    [2, 3],
    "both lines of the thought, not the first alone",
  );
  assert.equal(value.phase, "listening");
  assert.ok(ms >= 750 && ms < 2500, `answered after ${ms} ms, about half a second after the last line`);

  const nothing = await timed(control.readTranscript(value.through, 200, 0.6, 0.5));
  assert.deepEqual(nothing.value.lines, [], "nothing new");
  assert.ok(nothing.ms >= 550, `waited ${nothing.ms} ms, as long as asked`);

  // the session stops while a read waits: it answers at once
  const stopping = timed(control.readTranscript(value.through, 200, 5, 0.5, file));
  await sleep(200);
  set(() => "idle");
  const ended = await stopping;
  assert.equal(ended.value.phase, "idle");
  assert.ok(ended.ms < 700, `a stopped session is answered at once, not after ${ended.ms} ms`);

  // Beluga stopped (a break): a read waits for the next session and reads its file from the start
  const next = join(work, "waiting-next.txt");
  const resuming = timed(control.readTranscript(ended.value.through, 200, 5, 0.3, file));
  await sleep(400);
  writeFileSync(next, "# Beluga transcript, started 2026-11-21 15:00\n15:00:04 Room: Weiter mit der Rechnung.\n");
  move(next);
  set(() => "listening");
  const resumed = await resuming;
  assert.equal(resumed.value.transcript, next);
  assert.deepEqual(
    resumed.value.lines.map((l) => l.line),
    [1, 2],
    "the new file from its start",
  );
  assert.ok(resumed.ms >= 400, `waited for the next session, ${resumed.ms} ms`);

  // a place in another file counts from the start; in the same file it holds
  const fresh = await control.readTranscript(value.through, 200, 0, 0, file);
  assert.deepEqual(
    fresh.lines.map((l) => l.line),
    [1, 2],
    "read from the start, not from line 3",
  );
  assert.deepEqual((await control.readTranscript(2, 200, 0, 0, next)).lines, [], "in the same file the place holds");
});

test("start and stop go through the window, and only when they make sense", async () => {
  const { deps, asked, set } = standIn();
  const control = createControl(deps);
  await control.setOptions({ model: "whisper-turbo" });
  await assert.rejects(control.start(), /not downloaded/);
  await control.setOptions({ model: "parakeet-v3" });
  assert.deepEqual(await control.start(), {
    transcript,
    channels: ["mic"],
    notice: null,
    notListenedFor: [],
  });
  await assert.rejects(control.start(), /not idle but listening/);
  assert.deepEqual(await control.stop(), { transcript });
  assert.deepEqual(asked, ["start", "stop"]);
  set(() => "starting");
  await assert.rejects(control.stop(), /still starting/);
});

let endpoint: AgentEndpoint;
let client: Client;

before(async () => {
  writeFileSync(transcript, "# Beluga transcript, started 2026-11-21 14:30\n14:30:05 Me: Wir fangen an.\n14:30:09 Oth");
  const { deps } = standIn();
  await createControl(deps).start();
  endpoint = await openAgentEndpoint({ port: 0, key: () => KEY, control: createControl(deps) });
  client = new Client({ name: "agent-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    }),
  );
});

after(async () => {
  await client.close();
  await endpoint.close();
  rmSync(work, { recursive: true, force: true });
});

test("the server offers its tools, and its instructions name no other", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "get_status",
    "read_transcript",
    "set_glossary",
    "set_options",
    "start_listening",
    "stop_listening",
  ]);
  assert.deepEqual(toolNamesIn(INSTRUCTIONS), names);
  assert.equal(client.getInstructions(), INSTRUCTIONS);
});

test("the transcript is read by line, without the line still being written", async () => {
  const { isError, text } = toolText(await client.callTool({ name: "read_transcript", arguments: { after: 1 } }));
  assert.equal(isError, false, text);
  assert.deepEqual(JSON.parse(text), {
    transcript,
    phase: "listening",
    lines: [{ line: 2, text: "14:30:05 Me: Wir fangen an." }],
    through: 2,
    more: false,
  });
  const began = Date.now();
  const waited = toolText(await client.callTool({ name: "read_transcript", arguments: { after: 2, wait: 0.4 } }));
  assert.equal(waited.isError, false, waited.text);
  assert.deepEqual(JSON.parse(waited.text).lines, []);
  assert.ok(Date.now() - began >= 350, "the wait reaches the tool");
  const other = toolText(
    await client.callTool({ name: "read_transcript", arguments: { after: 2, transcript: "/elsewhere/beluga.txt" } }),
  );
  assert.equal(JSON.parse(other.text).lines.length, 2, "a place in another file counts from the start");
});

test("a refused request is an error result the agent can read", async () => {
  const { isError, text } = toolText(
    await client.callTool({ name: "set_options", arguments: { tuning: { pause: 0.8 } } }),
  );
  assert.equal(isError, true);
  assert.match(text, /Beluga is listening, and the options hold for a whole session/);
});

/** a raw request to the endpoint, as a stranger would send it (node:http: fetch does not let a Host header through) */
function raw(init: { path?: string; method?: string; headers?: Record<string, string> }): Promise<number> {
  const url = new URL(init.path ?? "/mcp", endpoint.url);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...init.headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(init.method === "GET" ? undefined : body);
  });
}

test("without Beluga's key, from a web page or by another host name nobody gets in", async () => {
  const key = { Authorization: `Bearer ${KEY}` };
  assert.equal(await raw({ headers: key }), 200);
  assert.equal(await raw({}), 401);
  assert.equal(await raw({ headers: { Authorization: `Bearer ${"x".repeat(43)}` } }), 401);
  assert.equal(await raw({ headers: { ...key, Origin: "https://example.com" } }), 403);
  assert.equal(await raw({ headers: { ...key, Host: "attacker.example" } }), 403);
  assert.equal(await raw({ headers: key, path: "/other" }), 404);
  assert.equal(await raw({ headers: key, method: "GET" }), 405);
});

/** the status line for a request target as it is sent, which no URL would write */
function rawTarget(target: string): Promise<string> {
  const { port } = new URL(endpoint.url);
  return new Promise((resolve, reject) => {
    let reply = "";
    const socket = connect(Number(port), "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => (reply += chunk.toString()));
    socket.on("end", () => resolve(reply.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

test("a malformed path is refused and brings nothing down", async () => {
  for (const target of ["//[", "//%", "//x:99999", "//127.0.0.1/mcp", "/mcp/../mcp"]) {
    assert.match(await rawTarget(target), /^HTTP\/1\.1 404 /, target);
  }
  assert.equal(await raw({ headers: { Authorization: `Bearer ${KEY}` } }), 200, "the endpoint still answers");
});

test("an endpoint without a key lets nobody in, not even with an empty one", async () => {
  const keyless = await openAgentEndpoint({ port: 0, key: () => "", control: createControl(standIn().deps) });
  try {
    const response = await fetch(keyless.url, {
      method: "POST",
      headers: { Authorization: "Bearer ", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
  } finally {
    await keyless.close();
  }
});
