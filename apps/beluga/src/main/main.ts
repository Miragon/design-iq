/**
 * Beluga's main process: one window, the capture permissions, the engine
 * process and the transcript file.
 */
import type { WriteStream } from "node:fs";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
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

import { checkGlossary, glossaryFromFile } from "../core/glossary.ts";
import type { EngineReply, EngineRequest, InitialState, Started, StartOptions } from "../core/ipc.ts";
import { DEFAULT_MODEL, megabytes, type ModelId, MODELS, modelSpec } from "../core/models.ts";
import { checkTuning } from "../core/settings.ts";
import {
  DEFAULT_LABELS,
  fileName,
  formatLine,
  headerLine,
  type SpeakerLabels,
  type Utterance,
} from "../core/transcript.ts";
import { missingFiles } from "../engine/files.ts";
import { installModel } from "./models.ts";

const PAGE = join(__dirname, "../../dist/index.html");
/** BELUGA_MODELS_DIR points development and tests at models that are already there; BELUGA_FOLDER sets where transcripts go by default */
const modelsDir = (): string => process.env.BELUGA_MODELS_DIR ?? join(app.getPath("userData"), "models");
/** while finishing, an engine that says nothing for this long hangs: a working one reports every second */
const HUNG_AFTER_MS = 30_000;
/** while finishing, an engine that gets no further for this long is stuck, though it still answers */
const STUCK_AFTER_MS = 5 * 60_000;
/** a glossary file larger than this is no brief and no list of terms */
const GLOSSARY_FILE_BYTES = 1_000_000;

let window: BrowserWindow | null = null;

interface Session {
  engine: UtilityProcess;
  file: WriteStream;
  path: string;
  labels: SpeakerLabels;
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

function initialState(): InitialState {
  return {
    models: MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      note: m.note,
      megabytes: megabytes(m.id),
      installed: missingFiles(modelsDir(), m.id).length === 0,
    })),
    model: DEFAULT_MODEL,
    folder: process.env.BELUGA_FOLDER ?? join(app.getPath("documents"), "Beluga"),
    labels: DEFAULT_LABELS,
    cores: availableParallelism(),
  };
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
  const line = formatLine(utterance, into.labels);
  if (line === null || !into.file.writable) return;
  into.file.write(`${line}\n`);
  send("beluga:line", { channel: utterance.channel, line });
}

async function start(options: StartOptions): Promise<Started> {
  if (current || starting || stopping) throw new Error("A session is already running.");
  starting = true;
  try {
    return await begin(options);
  } finally {
    starting = false;
  }
}

async function begin(options: StartOptions): Promise<Started> {
  modelSpec(options.model);
  const glossary = checkGlossary(options.glossary);
  const tuning = checkTuning(options.tuning);
  if (process.platform === "darwin" && !(await systemPreferences.askForMediaAccess("microphone"))) {
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
            send("beluga:lag", Math.max(0, Math.round((listening.newest - reply.at) / 1000)));
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
    tuning,
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
  listening = { engine, ...transcript, labels: options.labels, newest: startedAt, heard: false };
  current = listening;
  lastPath = transcript.path;
  return { path: transcript.path, left };
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
    autoHideMenuBar: true,
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
  void window.loadFile(PAGE);
}

void app.whenReady().then(() => {
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
});

const quit = (): void =>
  void stop()
    .catch((error: unknown) => console.error(reason(error)))
    .finally(() => app.quit());

// closing the window ends the session and the app
app.on("window-all-closed", quit);
// Quit from the menu, the Dock, a logout: Electron closes no window first, so the
// session is ended here, then the quit goes on
app.on("before-quit", (event) => {
  if (quitting || (!current && !stopping)) return;
  event.preventDefault();
  quitting = true;
  // the window shows that the session is finishing, and stops listening
  send("beluga:finishing", null);
  quit();
});
