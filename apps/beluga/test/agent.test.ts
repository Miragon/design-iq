/**
 * The agent's way into Beluga: what its tools do (against a stand-in for the
 * main process) and who gets through the endpoint (over real HTTP).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

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

/** the main process as the tools see it, with a record of what they asked it to do */
function standIn(): {
  deps: ControlDeps;
  asked: string[];
  prefs: () => Preferences;
  set: (p: ControlDeps["phase"]) => void;
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
        path = transcript;
        return Promise.resolve({ ok: true, channels: ["mic"], notice: null });
      }
      phase = "idle";
      return Promise.resolve({ ok: true, channels: [], notice: null });
    },
    whenStopped: () => Promise.resolve(),
  };
  return { deps, asked, prefs: () => prefs, set: (p) => (phase = p()) };
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
    lines: [{ line: 2, text: "14:30:05 Me: Wir fangen an." }],
    through: 2,
    more: false,
  });
});

test("a refused request is an error result the agent can read", async () => {
  const { isError, text } = toolText(
    await client.callTool({ name: "set_options", arguments: { tuning: { threads: 0 } } }),
  );
  assert.equal(isError, true);
  assert.match(text, /threads is out of range/);
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
