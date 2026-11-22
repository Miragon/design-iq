/**
 * Beluga's main process: one window, the capture permissions, the engine
 * process, the transcript file, the preferences and, when the person allows
 * it, the endpoint an agent controls Beluga through.
 */
import type { WriteStream } from "node:fs";
import { constants, readFileSync } from "node:fs";
import { access, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  net,
  session,
  shell,
  systemPreferences,
  type UtilityProcess,
  utilityProcess,
} from "electron";

import { createControl } from "../agent/control.ts";
import { AGENT_PORT, type AgentEndpoint, openAgentEndpoint } from "../agent/endpoint.ts";
import { glossaryFromFile, parseGlossary } from "../core/glossary.ts";
import type {
  AgentInfo,
  EngineReply,
  EngineRequest,
  InitialState,
  RemoteCommand,
  RemoteResult,
  Started,
} from "../core/ipc.ts";
import { megabytes, type ModelId, MODELS, modelSpec } from "../core/models.ts";
import type { Preferences } from "../core/preferences.ts";
import { fileName, headerLine, lineParts, lineText, type SpeakerLabels, type Utterance } from "../core/transcript.ts";
import { missingFiles } from "../engine/files.ts";
import { hotwords, PieceEncoder } from "../engine/hotwords.ts";
import { installModel } from "./models.ts";
import { AgentKey, PreferenceStore } from "./store.ts";

const PAGE = join(__dirname, "../../dist/index.html");
/** the app icon, for the window (Windows, Linux) and the Dock; a packaged app also has it in its bundle */
const ICON = join(__dirname, "../../resources/icon.png");
const MAC = process.platform === "darwin";
/** BELUGA_MODELS_DIR points development and tests at models that are already there; BELUGA_FOLDER sets where transcripts go by default */
const modelsDir = (): string => process.env.BELUGA_MODELS_DIR ?? join(app.getPath("userData"), "models");
/** while finishing, an engine that says nothing for this long hangs: a working one reports every second */
const HUNG_AFTER_MS = 30_000;
/** while finishing, an engine that gets no further for this long is stuck, though it still answers */
const STUCK_AFTER_MS = 5 * 60_000;
/** a glossary file larger than this is no brief and no list of terms */
const GLOSSARY_FILE_BYTES = 1_000_000;
/** BELUGA_AGENT_PORT moves the agent's endpoint, for tests next to a running Beluga */
const agentPort = Number(process.env.BELUGA_AGENT_PORT ?? AGENT_PORT);
/** how long an agent's start may take: the model loads, a permission prompt may wait for the person */
const REMOTE_START_MS = 120_000;
/** how long an agent's stop may take: the engine catches up first */
const REMOTE_STOP_MS = 15 * 60_000;

let window: BrowserWindow | null = null;

interface Session {
  engine: UtilityProcess;
  file: WriteStream;
  path: string;
  model: ModelId;
  labels: SpeakerLabels;
  /** glossary entries the model does not listen for */
  left: string[];
  /** seconds the transcript runs behind, as the engine last reported */
  behind: number | null;
  /** when the newest piece of audio handed to the engine was captured */
  newest: number;
  /** whether any audio arrived: a session that heard nothing leaves no file */
  heard: boolean;
  /** the first error writing the file, which ends the session */
  error?: Error;
}
/** the session that is listening; a session that is finishing is no longer current */
let current: Session | null = null;
let starting = false;
let stopping: Promise<void> | null = null;
let quitting = false;
/** one download at a time: the models share the detector's file */
let installing: ModelId | null = null;
/** the transcript of the running or the last session: the one file the page may reveal */
let lastPath: string | null = null;
/** made once the app is ready: they need its data folder */
let store: PreferenceStore;
let agentKey: AgentKey;
let endpoint: AgentEndpoint | null = null;
let agent: AgentInfo = { url: `http://127.0.0.1:${agentPort}/mcp`, state: "off" };
/** opening and closing the endpoint, one after the other */
let agentChange: Promise<void> = Promise.resolve();
/** the page has its listeners in place: an agent's start or stop reaches it */
let pageReady = false;
/** an agent's starts and stops the page is carrying out */
const remotes = new Map<number, (result: RemoteResult) => void>();
let nextRemote = 1;
/** Parakeet's pieces, read once, to tell which glossary entries it cannot write */
let parakeetPieces: PieceEncoder | null = null;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** the URL of Beluga's page, compared as a path: Chromium and Node escape a file URL differently */
function isOwnPage(url: string | undefined): boolean {
  if (!url?.startsWith("file:")) return false;
  try {
    return fileURLToPath(url) === PAGE;
  } catch {
    return false;
  }
}

/** only Beluga's own page, in Beluga's own window, may call into the main process */
function fromOwnPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return window !== null && event.sender.id === window.webContents.id && frame?.parent === null && isOwnPage(frame.url);
}

function handle<Args extends unknown[], Result>(
  channel: string,
  handler: (...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromOwnPage(event)) throw new Error("refused");
    return handler(...(args as Args));
  });
}

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

const installed = (model: ModelId): boolean => missingFiles(modelsDir(), model).length === 0;

function initialState(): InitialState {
  return {
    models: MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      note: m.note,
      megabytes: megabytes(m.id),
      installed: installed(m.id),
    })),
    preferences: store.get(),
    cores: availableParallelism(),
    agent,
    titleBarInset: MAC,
  };
}

/** the glossary entries a model does not listen for: Whisper takes none, Parakeet not all */
function notListenedFor(model: ModelId, entries: string[]): string[] {
  if (model !== "parakeet-v3") return [...entries];
  if (!installed(model)) return [];
  parakeetPieces ??= new PieceEncoder(readFileSync(join(modelsDir(), modelSpec(model).dir, "tokens.txt"), "utf8"));
  return hotwords(entries, parakeetPieces).left;
}

/** keeps a change of the preferences made outside the window, and shows it there */
function updatePreferences(change: Partial<Preferences>): void {
  const agentBefore = store.get().agent;
  store.update(change);
  send("beluga:preferences", store.get());
  if (store.get().agent !== agentBefore) syncAgent();
}

/** a new glossary for the running session, from its next utterance on; null when none runs */
function glossaryToSession(entries: string[]): string[] | null {
  if (!current) return null;
  current.engine.postMessage({ type: "glossary", entries } satisfies EngineRequest);
  current.left = notListenedFor(current.model, entries);
  // the window warns about Parakeet's entries only: Whisper takes no glossary, and the window says so
  send("beluga:left", current.model === "whisper-turbo" ? [] : current.left);
  return current.left;
}

const phase = (): "idle" | "starting" | "listening" | "stopping" =>
  starting ? "starting" : current ? "listening" : stopping ? "stopping" : "idle";

/** asks the page to start or stop listening, as if the person had clicked, and waits for how it went */
function remote(action: RemoteCommand["action"]): Promise<RemoteResult> {
  if (!window || !pageReady) return Promise.resolve({ ok: false, message: "Beluga's window is not ready yet." });
  const id = nextRemote++;
  return new Promise((resolve) => {
    const timer = setTimeout(
      () =>
        done({
          ok: false,
          message:
            action === "start"
              ? "Beluga did not start listening within two minutes. Is a permission prompt waiting on the computer?"
              : "Beluga did not finish the session within fifteen minutes.",
        }),
      action === "start" ? REMOTE_START_MS : REMOTE_STOP_MS,
    );
    const done = (result: RemoteResult): void => {
      clearTimeout(timer);
      remotes.delete(id);
      resolve(result);
    };
    remotes.set(id, done);
    send("beluga:remote", { id, action } satisfies RemoteCommand);
  });
}

const control = createControl({
  preferences: () => store.get(),
  updatePreferences,
  phase,
  transcriptPath: () => current?.path ?? lastPath,
  behind: () => current?.behind ?? null,
  installed,
  notListenedFor,
  glossaryToSession: (entries) => Promise.resolve(glossaryToSession(entries)),
  sessionLeft: () => current?.left ?? null,
  remote,
  whenStopped: () => (stopping ?? Promise.resolve()).catch(() => undefined),
});

/** opens or closes the agent's endpoint as the preferences say, and tells the window */
function syncAgent(): void {
  agentChange = agentChange.then(async () => {
    const wanted = store.get().agent;
    if (wanted && !endpoint) {
      try {
        await agentKey.get();
        endpoint = await openAgentEndpoint({ port: agentPort, key: () => agentKey.current(), control });
        agent = { url: endpoint.url, state: "on" };
      } catch (error) {
        const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
        agent = {
          url: agent.url,
          state: "failed",
          message: inUse ? `Port ${agentPort} is taken: is another Beluga running?` : reason(error),
        };
      }
    } else if (!wanted) {
      await endpoint?.close();
      endpoint = null;
      agent = { url: agent.url, state: "off" };
    }
    send("beluga:agent", agent);
  });
}

/** a new transcript file, never an existing one: a second session in the same minute gets `-2` */
async function createTranscript(
  folder: string,
  startedAt: number,
  onError: (error: Error) => void,
): Promise<{ file: WriteStream; path: string }> {
  for (let attempt = 1; ; attempt++) {
    const path = join(folder, fileName(startedAt, attempt));
    try {
      const handle = await open(path, "wx");
      const file = handle.createWriteStream();
      file.on("error", onError);
      file.write(`${headerLine(startedAt)}\n`);
      return { file, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 99) throw error;
    }
  }
}

/** ends a session that fails while it listens, and tells the page why */
function fail(ending: Session, message: string): void {
  if (current !== ending) return;
  current = null;
  ending.engine.kill();
  if (ending.file.writable) ending.file.end();
  send("beluga:session-ended", message);
}

function write(into: Session, utterance: Utterance): void {
  const parts = lineParts(utterance, into.labels);
  if (parts === null || !into.file.writable) return;
  into.file.write(`${lineText(parts)}\n`);
  send("beluga:line", { channel: utterance.channel, ...parts });
}

async function start(): Promise<Started> {
  if (current || starting || stopping) throw new Error("A session is already running.");
  // the download's end reloads the window's state, which would end a session started meanwhile
  if (installing) throw new Error("A model is being downloaded. Start once the download is done.");
  starting = true;
  try {
    return await begin(store.get());
  } finally {
    starting = false;
  }
}

async function begin(options: Preferences): Promise<Started> {
  const glossary = parseGlossary(options.glossary);
  if (MAC && !(await systemPreferences.askForMediaAccess("microphone"))) {
    throw new Error("Beluga has no access to the microphone. Allow it in System Settings, Privacy & Security.");
  }
  try {
    await mkdir(options.folder, { recursive: true });
    await access(options.folder, constants.W_OK);
  } catch (error) {
    throw new Error(`Beluga cannot write to ${options.folder}. Choose another folder. (${reason(error)})`);
  }

  const engine = utilityProcess.fork(join(__dirname, "engine-host.cjs"), [], { serviceName: "Beluga speech engine" });
  // a fatal error in the engine is followed by its exit, which ends the session
  engine.on("error", (type, location) => console.error(`speech engine: ${type} at ${location}`));
  let listening: Session | null = null;
  const ready = new Promise<string[]>((resolve, reject) => {
    engine.on("message", (reply: EngineReply) => {
      switch (reply.type) {
        case "ready":
          resolve(reply.left);
          break;
        case "utterance":
          if (listening) write(listening, reply);
          break;
        case "progress":
          if (listening && reply.at !== null) {
            listening.behind = Math.max(0, Math.round((listening.newest - reply.at) / 1000));
            send("beluga:lag", listening.behind);
          }
          break;
        case "error":
          reject(new Error(reply.message));
          if (listening) fail(listening, `The speech engine failed: ${reply.message}`);
          break;
        case "stopped":
          break;
      }
    });
    engine.once("exit", (code) => {
      reject(new Error(`The speech engine stopped while loading the model (exit code ${code}).`));
      if (listening) fail(listening, `The speech engine stopped unexpectedly (exit code ${code}).`);
    });
  });
  engine.postMessage({
    type: "start",
    modelsDir: modelsDir(),
    model: options.model,
    language: options.language,
    glossary,
    tuning: options.settings.tuning,
  } satisfies EngineRequest);
  let left: string[];
  try {
    left = await ready;
  } catch (error) {
    engine.kill();
    throw error;
  }

  // the file is created once the model runs, so a failed start leaves none behind
  const startedAt = Date.now();
  let transcript: { file: WriteStream; path: string };
  try {
    transcript = await createTranscript(options.folder, startedAt, (error) => {
      if (!listening) return;
      listening.error ??= error;
      fail(listening, `The transcript file cannot be written: ${error.message}`);
    });
  } catch (error) {
    engine.kill();
    throw new Error(`Beluga cannot create the transcript file in ${options.folder}. (${reason(error)})`);
  }
  listening = {
    engine,
    ...transcript,
    model: options.model,
    labels: options.labels,
    left,
    behind: null,
    newest: startedAt,
    heard: false,
  };
  current = listening;
  lastPath = transcript.path;
  // a glossary set while the session started (by an agent, say) counts from now on
  const now = store.get().glossary;
  if (now !== options.glossary) glossaryToSession(parseGlossary(now));
  return { path: transcript.path, left: listening.left };
}

/** the glossary of a file the facilitator picks: a workshop brief's table, or a list one entry per line */
async function importGlossary(): Promise<string[] | null> {
  if (!window) return null;
  const result = await dialog.showOpenDialog(window, {
    title: "Take the glossary from a workshop brief or a list",
    properties: ["openFile"],
    filters: [{ name: "Workshop brief or list", extensions: ["md", "txt"] }],
  });
  const path = result.canceled ? undefined : result.filePaths[0];
  if (!path) return null;
  if ((await stat(path)).size > GLOSSARY_FILE_BYTES) throw new Error("This file is too large for a glossary.");
  return glossaryFromFile(await readFile(path, "utf8"));
}

/** ends the session: the engine transcribes what it still holds, then the file is closed */
function stop(): Promise<void> {
  stopping ??= finish().finally(() => (stopping = null));
  return stopping;
}

async function finish(): Promise<void> {
  const ending = current;
  if (!ending) return;
  current = null;
  try {
    await new Promise<void>((resolve, reject) => {
      // with a backlog, finishing takes as long as the engine needs: it ends
      // only when the engine stops answering, or answers without getting further
      let heard = Date.now();
      let advanced = heard;
      let through: number | null = null;
      let watch: NodeJS.Timeout | undefined = undefined;
      const settle = (error?: Error): void => {
        clearInterval(watch);
        if (error) reject(error);
        else resolve();
      };
      watch = setInterval(() => {
        const now = Date.now();
        if (now - heard > HUNG_AFTER_MS || now - advanced > STUCK_AFTER_MS) {
          settle(new Error("The speech engine stopped responding. The end of the meeting is missing."));
        }
      }, 1000);
      ending.engine.on("message", (reply: EngineReply) => {
        heard = Date.now();
        if (reply.type === "utterance" || (reply.type === "progress" && reply.at !== through)) {
          advanced = heard;
          if (reply.type === "progress") through = reply.at;
        }
        if (reply.type === "stopped") settle();
        else if (reply.type === "error")
          settle(new Error(`The speech engine failed while finishing: ${reply.message}`));
      });
      ending.engine.once("exit", (code) =>
        settle(new Error(`The speech engine stopped while finishing (exit code ${code}).`)),
      );
      ending.engine.postMessage({ type: "stop" } satisfies EngineRequest);
    });
  } finally {
    ending.engine.kill();
    if (ending.file.writable) await new Promise<void>((resolve) => ending.file.end(() => resolve()));
    // the page could not open the microphone: no session took place
    if (!ending.heard) {
      await rm(ending.path, { force: true });
      if (lastPath === ending.path) lastPath = null;
    }
  }
  if (ending.error) throw new Error(`The end of the transcript could not be written: ${ending.error.message}`);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 400,
    minHeight: 560,
    title: "Beluga",
    icon: ICON,
    autoHideMenuBar: true,
    // on macOS the page's header is the title bar, the traffic lights centred in its 56 px
    ...(MAC ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 21 } } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Beluga shows one local page: it opens nothing and goes nowhere else
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => (window = null));
  // a page that loads again has no listeners until it asks for its state: an agent's request waiting on it fails
  window.webContents.on("did-start-loading", () => {
    pageReady = false;
    for (const done of [...remotes.values()]) done({ ok: false, message: "Beluga's window reloaded." });
  });
  void window.loadFile(PAGE);
}

void app.whenReady().then(() => {
  // without it, a Beluga started from source shows Electron's icon in the Dock
  if (MAC) app.dock?.setIcon(ICON);
  store = new PreferenceStore(
    app.getPath("userData"),
    process.env.BELUGA_FOLDER ?? join(app.getPath("documents"), "Beluga"),
  );
  agentKey = new AgentKey(app.getPath("userData"));

  // microphone and system audio, for Beluga's own page and nothing else
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const own = window !== null && contents.id === window.webContents.id && isOwnPage(contents.getURL());
    callback(own && (permission === "media" || permission === "display-capture"));
  });
  // the page asks for the system's sound through getDisplayMedia, which insists
  // on a video track: Beluga offers its own window as that track (no screen is
  // captured, no screen permission asked) and the page stops it at once
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame;
    if (!frame || !isOwnPage(frame.url)) return callback(null);
    callback({ video: frame, audio: "loopback" });
  });

  // a page that loads again (a reload) starts without a session: one still running is finished first
  handle("beluga:init", async () => {
    await stop().catch((error: unknown) => console.error(reason(error)));
    pageReady = true;
    return initialState();
  });
  handle("beluga:choose-folder", async (currentFolder: string) => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      defaultPath: currentFolder,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle("beluga:install-model", async (model: ModelId) => {
    modelSpec(model);
    if (installing) throw new Error("A model is already being downloaded.");
    installing = model;
    try {
      await installModel(
        modelsDir(),
        model,
        (progress) => send("beluga:download", progress),
        (url, signal) => net.fetch(url, { signal }),
      );
    } finally {
      installing = null;
    }
  });
  handle("beluga:import-glossary", importGlossary);
  handle("beluga:start", start);
  handle("beluga:stop", stop);
  ipcMain.on("beluga:set-preferences", (event, change: unknown) => {
    if (!fromOwnPage(event)) return;
    const agentBefore = store.get().agent;
    store.update(change);
    if (store.get().agent !== agentBefore) syncAgent();
  });
  ipcMain.on("beluga:remote-done", (event, id: unknown, result: unknown) => {
    if (!fromOwnPage(event) || typeof id !== "number") return;
    const ok = (result as { ok?: unknown } | null)?.ok;
    if (typeof ok !== "boolean") return;
    remotes.get(id)?.(result as RemoteResult);
  });
  handle("beluga:copy-agent-command", async () => {
    if (agent.state !== "on") throw new Error("Agent access is off.");
    await clipboard.writeText(
      `claude mcp add --transport http beluga ${agent.url} --header "Authorization: Bearer ${agentKey.current()}"`,
    );
  });
  handle("beluga:renew-agent-key", () => agentKey.renew());
  ipcMain.on("beluga:audio", (event, channel: unknown, samples: unknown, at: unknown) => {
    if (!current || !fromOwnPage(event)) return;
    if (channel !== "mic" && channel !== "system") return;
    if (!(samples instanceof Float32Array) || typeof at !== "number" || !Number.isFinite(at)) return;
    current.newest = Math.max(current.newest, at);
    current.heard = true;
    current.engine.postMessage({ type: "audio", channel, samples, at } satisfies EngineRequest);
  });
  ipcMain.on("beluga:show-file", (event, path: unknown) => {
    if (fromOwnPage(event) && typeof path === "string" && path === lastPath) shell.showItemInFolder(path);
  });

  createWindow();
  syncAgent();
});

const quit = (): void =>
  void stop()
    .catch((error: unknown) => console.error(reason(error)))
    .finally(() => {
      store.flushSync();
      app.quit();
    });

// closing the window ends the session and the app
app.on("window-all-closed", quit);
// Quit from the menu, the Dock, a logout: Electron closes no window first, so the
// session is ended here, then the quit goes on
app.on("before-quit", (event) => {
  store.flushSync();
  if (quitting || (!current && !stopping)) return;
  event.preventDefault();
  quitting = true;
  // the window shows that the session is finishing, and stops listening
  send("beluga:finishing", null);
  quit();
});
