/**
 * Content read-model + write use-case over the LIVE documents — the REST/MCP
 * path to the same document the collaborative rooms edit: the Y.Text of a
 * text notation, the element maps of a structured one (a board), which travel
 * as their codec's canonical text. Reads and writes go through a server-side
 * Hocuspocus direct connection (injected as `openDoc`), so a PUT lands in the
 * live doc like any co-editor's keystrokes: broadcast to open editors, then
 * written through to the workspace tree.
 *
 * A structured document holds only what its codec writes back, so a text its
 * strict reader refuses (DocCodec.check) never enters one: a file on disk like
 * that is not opened (422 content/unreadable-model, the file untouched; a
 * valid save over it repairs it), and a save of one is refused whatever its
 * `lint` (422 content/invalid-model).
 *
 * Direct connections bypass two ws-only gates, which therefore live HERE:
 *   - authorization: the HTTP route (repoOf/canWrite) authorizes per request —
 *     stronger than the ws model's authorize-once-at-socket-open
 *   - the ingest size cap (beforeHandleMessage): putContent enforces
 *     maxDocBytes itself, BEFORE any doc mutation (a CRDT can't shrink)
 *
 * Optimistic concurrency: baseVersion = a hash of the CONTENT the caller read.
 * Deliberately NOT the Yjs state vector: the vector is blind to delete-only
 * edits (deletions live in the DeleteSet) and is bound to the doc INSTANCE —
 * after an unload/reseed cycle it changes without any edit, which would fail
 * every save issued minutes after its read. The classic ABA objection to a
 * content hash does not apply here: writes go through the minimal-diff writer,
 * so overwriting identical bytes is a no-op — nothing existing is ever lost.
 * PUT REQUIRES the token from a prior GET; on mismatch it returns the current
 * content instead of writing — a caller can never overwrite an edit it has
 * not seen.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CONTENT_KEY, roomName } from "@designiq/contracts/live";
import type {
  ContentConflictWire,
  ContentWire,
  PutContentRequest,
  PutContentResultWire,
} from "@designiq/contracts/live-host";
import { AppError } from "@designiq/http-kit";
import { readSnapshot, reconcileSnapshot } from "@designiq/live-client/structured";
import { updateText } from "@designiq/live-client/text";
import { byExtension } from "@designiq/notations";
import type { DocCodec } from "@designiq/notations/codecs";
import { hasRefs } from "@designiq/notations/refs";
import { checkModel, type Finding } from "@miragon/design-iq-validator";
import type * as Y from "yjs";

import {
  docCodecForPath,
  NotAContentRepoError,
  type RegistryLookup,
  toDiskPath,
  UnreadableDocumentError,
  type WorkspaceEnsure,
} from "../domain/rooms.ts";
import { type DiscoveredModel, discoverModels, loadContentConfig } from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { modelPath } from "./model-path.ts";
import { modelFileRefusal } from "./workspace-paths.ts";

/** the minimal direct-connection surface (structural — no @hocuspocus import) */
export interface DirectDoc {
  transact(cb: (doc: Y.Doc) => void): Promise<void>;
  disconnect(): Promise<void>;
  /** the underlying doc — probed for the open-during-unload race (see withDoc) */
  document?: { isDestroyed: boolean } | null;
}

export interface ContentDeps {
  registry: RegistryLookup;
  workspaces: WorkspaceEnsure;
  /** server-side handle to a live room (server.ts: hocuspocus.openDirectConnection) */
  openDoc: (room: string) => Promise<DirectDoc>;
  /** the room size cap — enforced here because beforeHandleMessage never runs
   *  for direct connections */
  maxDocBytes: number;
  /** the STRUCTURED lane's codec per path (epic #118 step 8) — defaults to
   *  the registry resolution (the board's codec for a .board, undefined for
   *  every text notation); tests inject their own */
  docCodec?: (path: string) => DocCodec | undefined;
}

/** the code of a structured file on disk its strict reader refuses: the
 *  room does not open it (domain/rooms.ts UnreadableDocumentError) */
export const UNREADABLE_MODEL = "content/unreadable-model";

export type PutOutcome =
  | {
      ok: true;
      result: PutContentResultWire;
      /** the document text the save replaced — with `next`, the input of the
       *  element diff the agent presence publishes (never on the wire) */
      previous: string;
      /** the canonical text the document holds after the save */
      next: string;
    }
  | { ok: false; conflict: ContentConflictWire };

/** a save that happened, given the text it replaced */
type Saved = (previous: string) => Extract<PutOutcome, { ok: true }>;

/** opaque optimistic-concurrency token (see header) — clients never parse it.
 *  Content-derived, so it survives doc unload/reseed cycles between read and save. */
export function baseVersionOf(content: string): string {
  return createHash("sha256").update(content).digest("base64url");
}

/** the live content of one model file + its concurrency token */
export async function getContent(opts: ContentDeps, repo: ConnectedRepo, path: string): Promise<ContentWire> {
  const safePath = modelPath(opts.registry, repo, path, "content/invalid-path");
  await assertOnDisk(opts, repo, safePath);
  let out: ContentWire | undefined;
  const codec = (opts.docCodec ?? docCodecForPath)(safePath);
  await withDoc(opts, repo, safePath, async (conn) => {
    await conn.transact((doc) => {
      // structured rooms (epic #118 step 8) read as their CANONICAL encoding —
      // the same text git, history and the validator see
      const content = codec ? codec.encode(readSnapshot(doc)) : doc.getText(CONTENT_KEY).toString();
      // `xml` is the deprecated alias of `content` (#154) — emitted for one release
      out = { repo: repo.fullName, path: safePath, content, xml: content, baseVersion: baseVersionOf(content) };
    });
  });
  if (!out) throw new Error(`read produced no content: ${safePath}`); // unreachable
  return out;
}

/** the document text of a PUT body: `content`, or the deprecated `xml` alias
 *  (#154) — `content` wins when both are present; undefined = malformed body */
function bodyText(body: PutContentRequest | undefined): string | undefined {
  const b = body as { content?: unknown; xml?: unknown } | undefined;
  if (typeof b?.content === "string") return b.content;
  return typeof b?.xml === "string" ? b.xml : undefined;
}

/** validate + compare-and-set the live document. Never writes on a stale token. */
export async function putContent(
  opts: ContentDeps,
  repo: ConnectedRepo,
  path: string,
  body: PutContentRequest,
): Promise<PutOutcome> {
  const safePath = modelPath(opts.registry, repo, path, "content/invalid-path");
  const text = bodyText(body);
  if (text === undefined) {
    throw new AppError("content/body-required", "body.content must be a string", { status: 400, expose: true });
  }
  if (typeof body.baseVersion !== "string" || body.baseVersion.length === 0) {
    throw new AppError(
      "content/base-version-required",
      "PUT requires baseVersion from a prior GET — read the current content first",
      { status: 400, expose: true },
    );
  }
  const { warnings, lintErrors } = await saveGate(opts, repo, safePath, text, body.lint);

  const codec = (opts.docCodec ?? docCodecForPath)(safePath);
  // a structured save normalizes: the doc's state after the write is the
  // canonical encoding of the DECODED payload — the returned token must match
  const canonicalNext = codec ? codec.encode(codec.decode(text)) : text;
  const saved: Saved = (previous) => ({
    ok: true,
    result: {
      path: safePath,
      baseVersion: baseVersionOf(canonicalNext),
      warnings,
      ...(lintErrors.length > 0 ? { errors: lintErrors } : {}),
    },
    previous,
    next: canonicalNext,
  });
  try {
    return await saveLive(opts, repo, safePath, text, body.baseVersion, codec, saved);
  } catch (e) {
    if (!codec || !(e instanceof AppError) || e.code !== UNREADABLE_MODEL) throw e;
  }
  // the file on disk is one the room refuses to open: this save repairs it,
  // unless that happened meanwhile and the room opens after all
  return (
    (await saveOverUnreadable(opts, repo, safePath, canonicalNext, body.baseVersion, codec, saved)) ??
    (await saveLive(opts, repo, safePath, text, body.baseVersion, codec, saved))
  );
}

/** putContent's compare-and-set on the live document */
async function saveLive(
  opts: ContentDeps,
  repo: ConnectedRepo,
  safePath: string,
  text: string,
  baseVersion: string,
  codec: DocCodec | undefined,
  saved: Saved,
): Promise<PutOutcome> {
  let outcome: PutOutcome | undefined;
  await withDoc(opts, repo, safePath, async (conn) => {
    // CAS + write inside ONE synchronous transact callback — atomic on the event
    // loop, so no remote update can land between the compare and the write
    await conn.transact((doc) => {
      const current = codec ? codec.encode(readSnapshot(doc)) : doc.getText(CONTENT_KEY).toString();
      const currentVersion = baseVersionOf(current);
      if (baseVersion !== currentVersion) {
        outcome = {
          ok: false,
          conflict: {
            error: "the document changed since your last read — re-derive your edit against currentContent and retry",
            code: "content/conflict",
            path: safePath,
            currentContent: current,
            currentXml: current, // deprecated alias (#154)
            baseVersion: currentVersion,
          },
        };
        return; // no mutation on conflict
      }
      if (codec) {
        // structured lane: element-/attribute-wise reconcile — a whole-board
        // agent save touches only what differs, so co-editors' concurrent
        // work on other elements merges instead of being replaced
        reconcileSnapshot(doc, codec.decode(text));
      } else {
        // minimal diff (shared writer with web/vscode) — co-editors see an
        // incremental update, not a replace-all
        updateText(doc.getText(CONTENT_KEY), text);
      }
      outcome = saved(current);
    });
  });
  if (!outcome) throw new Error(`write produced no outcome: ${safePath}`); // unreachable
  return outcome;
}

/**
 * A save over a structured file the room refuses to open (its strict reader
 * refuses the text on disk): besides git, the way to repair one. Nothing is
 * live at that path (every load of it is refused, and a refused load leaves
 * no lineage), so the compare-and-set runs on the FILE: its token is the
 * baseVersion of the text on disk, which a save with any other token gets
 * back as a conflict, like a stale live save. The text written is the
 * canonical encoding of a payload the strict reader took (saveGate), so the
 * room opens again. Undefined when the file reads again by now (repaired
 * meanwhile): the save then goes through the room.
 */
async function saveOverUnreadable(
  opts: ContentDeps,
  repo: ConnectedRepo,
  safePath: string,
  canonicalNext: string,
  baseVersion: string,
  codec: DocCodec,
  saved: Saved,
): Promise<PutOutcome | undefined> {
  const room = roomName(repo.fullName, safePath);
  return inRoomQueue(room, async () => {
    // the model file guard every lane shares: no symlink, nothing outside
    // the models folder or in .git is read back or written over
    const { disk } = await assertOnDisk(opts, repo, safePath);
    const current = await readFile(disk, "utf8");
    const why = codec.check?.(current);
    if (why === undefined) return undefined;
    const currentVersion = baseVersionOf(current);
    if (baseVersion !== currentVersion) {
      const noun = byExtension(safePath)?.noun.singular ?? "model";
      return {
        ok: false,
        conflict: {
          error:
            `${safePath} is not a ${noun} this host can open without losing content (${why}): currentContent ` +
            `is its text on disk. Save a valid ${noun} with this baseVersion to repair it`,
          code: "content/conflict",
          path: safePath,
          currentContent: current,
          currentXml: current, // deprecated alias (#154)
          baseVersion: currentVersion,
        },
      };
    }
    await replaceFile(disk, canonicalNext);
    console.log(`repaired: ${room} (an unreadable ${byExtension(safePath)?.id ?? "model"} saved over)`);
    return saved(current);
  });
}

/**
 * Write `text` over the file at `disk` in one step: into a temp file beside
 * it, renamed over it. The repair writes outside the room, and a ws load
 * takes no part in content.ts's room queue: a file written in place is
 * truncated before it is written, and a load reading it then would take the
 * empty text for an empty board, seed the room with it, and its next store
 * would write that over the repaired file. A load now reads the old text
 * (refused) or the whole new one. The rename also replaces a symlink swapped
 * in meanwhile instead of writing through it. The temp file's name starts
 * with "." so no room ever maps to it (splitRoom), and `wx` never opens
 * anything already there; it is removed when the write fails.
 */
async function replaceFile(disk: string, text: string): Promise<void> {
  const temp = join(dirname(disk), `.${basename(disk)}.${randomUUID()}.tmp`);
  // the file keeps its permission bits (git records the executable one)
  const mode = (await stat(disk)).mode & 0o777;
  try {
    await writeFile(temp, text, { flag: "wx", mode });
    await rename(temp, disk);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** what a save of a text would do, without saving (checkContent): the
 *  findings it would report, or the refusal it would throw */
export type SaveCheck =
  { ok: true; warnings: string[]; errors?: string[] } | { ok: false; code: string; status: number; message: string };

/**
 * putContent's verdict on `body.content` without touching the document — the
 * same gates in the same order (path, size cap, content repo + file, the
 * validation with `lint`), so a dry run reports exactly what the save would do
 * (#236: a dry run that skips the validator can say ok to a save the gate then
 * refuses). The compare-and-set is the one gate it cannot run ahead of time.
 */
export async function checkContent(
  opts: ContentDeps,
  repo: ConnectedRepo,
  path: string,
  body: { content: string; lint?: "block" | "warn" },
): Promise<SaveCheck> {
  try {
    const safePath = modelPath(opts.registry, repo, path, "content/invalid-path");
    const { warnings, lintErrors } = await saveGate(opts, repo, safePath, body.content, body.lint);
    return { ok: true, warnings, ...(lintErrors.length > 0 ? { errors: lintErrors } : {}) };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, status: e.status, message: e.message };
    throw e;
  }
}

/** the gates of a save before its compare-and-set (putContent, checkContent):
 *  throws the AppError of a refusal, returns the findings the save reports */
async function saveGate(
  opts: ContentDeps,
  repo: ConnectedRepo,
  safePath: string,
  text: string,
  lint: "block" | "warn" | undefined,
): Promise<{ warnings: string[]; lintErrors: string[] }> {
  // size cap FIRST: a CRDT can't shrink after the fact, and the ws-side ingest
  // guard (beforeHandleMessage) does not run for direct connections
  if (Buffer.byteLength(text, "utf8") > opts.maxDocBytes) {
    throw new AppError("content/too-large", `content exceeds the ${opts.maxDocBytes}-byte document cap`, {
      status: 413,
      expose: true,
    });
  }
  const { workspace } = await assertOnDisk(opts, repo, safePath);

  // a STRUCTURED document holds only what its codec writes back: a text its
  // strict reader refuses (a line that is no JSON, a repeated id) would lose
  // exactly that in the live document, so no lint mode saves it: "warn"
  // keeps what the validator flags, and this text cannot be kept as it is.
  // The validator's ERROR for it says the same (`<notation>/parse`)
  const refused = (opts.docCodec ?? docCodecForPath)(safePath)?.check?.(text);
  if (refused !== undefined) {
    const noun = byExtension(safePath)?.noun.singular ?? "model";
    throw new AppError(
      "content/invalid-model",
      `validation failed:\n- ${refused}\nA ${noun} text its reader refuses is never saved, whatever \`lint\` says: ` +
        `the live ${noun} could not hold what the reader skips.`,
      { status: 422, expose: true },
    );
  }

  // full platform validation per notation — checkModel, the one dispatch the
  // CLI runs too (BPMN structure + BPMNDI coverage + links, DMN table/DMNDI/
  // requirement integrity, the schema model of the Miragon JSON notations, so
  // nothing their canvas refuses to open lands, the baseline parse of every
  // other notation; the FEEL semantics live in the analyze_decision tool, not
  // on the write path).
  // A path that is no registered notation (a YAML sidecar) passes unvalidated.
  // lint:"warn" reports ERRORs on the result instead of refusing — the modeler
  // widget's autosave path; the ws rooms have never gated live edits, so this
  // is the same trust level, not a new one. Default stays "block" (REST + agents).
  let warnings: string[] = [];
  let lintErrors: string[] = [];
  const findings = await lintModel(workspace, safePath, text);
  if (findings) {
    const errors = findings.filter((f) => f.severity === "ERROR");
    if (errors.length > 0 && lint !== "warn") {
      throw new AppError(
        "content/invalid-model",
        `validation failed:\n- ${errors.map((f) => f.message).join("\n- ")}`,
        {
          status: 422,
          expose: true,
        },
      );
    }
    lintErrors = errors.map((f) => f.message);
    warnings = findings.filter((f) => f.severity === "WARN").map((f) => f.message);
  }
  return { warnings, lintErrors };
}

/**
 * Rewrite a document's LIVE content through `edit` (#208: a renamed model's
 * callers follow its new id) — the co-editor path: minimal diff into the
 * room, broadcast to anyone who has it open, written through on disconnect.
 * No CAS and no validation gate: `edit` is a deterministic transformation of
 * whatever the document holds at that instant, applied inside one transact.
 * A structured room (a board that shows the renamed or moved model) is edited
 * as its canonical text and reconciled element by element, so a co-editor's
 * change of another element stays.
 */
export async function editContent(
  opts: ContentDeps,
  repo: ConnectedRepo,
  path: string,
  edit: (content: string) => string,
): Promise<void> {
  const safePath = modelPath(opts.registry, repo, path, "content/invalid-path");
  await assertOnDisk(opts, repo, safePath);
  const codec = (opts.docCodec ?? docCodecForPath)(safePath);
  const tooLarge = (next: string): void => {
    if (Buffer.byteLength(next, "utf8") > opts.maxDocBytes) {
      throw new AppError("content/too-large", `content exceeds the ${opts.maxDocBytes}-byte document cap`, {
        status: 413,
        expose: true,
      });
    }
  };
  await withDoc(opts, repo, safePath, async (conn) => {
    await conn.transact((doc) => {
      if (codec) {
        const current = codec.encode(readSnapshot(doc));
        const next = edit(current);
        if (next === current) return;
        tooLarge(next);
        reconcileSnapshot(doc, codec.decode(next));
        return;
      }
      const ytext = doc.getText(CONTENT_KEY);
      const next = edit(ytext.toString());
      tooLarge(next);
      updateText(ytext, next);
    });
  });
}

/** the platform validator for whatever notation this path is — checkModel is
 *  THE one dispatch the CLI also runs, so a live save and `pnpm validate`
 *  always agree; `undefined` when the path is no registered notation (the
 *  file still saves). The repo-wide model scan feeds only the reference
 *  checks, so only saves of a notation WITH a refs emitter pay for it. */
async function lintModel(workspace: string, safePath: string, content: string): Promise<Finding[] | undefined> {
  const refs = hasRefs(byExtension(safePath)?.id ?? "") ? await refContextOf(workspace) : undefined;
  return checkModel(content, { path: safePath, ...refs });
}

/** the repo context of checkModel's reference checks, as the CLI passes it:
 *  the listed models (a board's node that names a moved model by its old
 *  path warns "moved to …") and the models folder (one outside it is said to
 *  be there); undefined when the workspace is no content repo */
export async function refContextOf(
  workspace: string,
): Promise<{ models: DiscoveredModel[]; modelsFolder: string } | undefined> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return undefined;
  return { models: await discoverModels(workspace, cfg), modelsFolder: cfg.models };
}

/** the model ids of a workspace per notation (file stems) — the link-check
 *  context of checkModel; undefined when the workspace is no content repo */
export async function modelIdsOf(workspace: string): Promise<Map<string, Set<string>> | undefined> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return undefined;
  const modelIds = new Map<string, Set<string>>();
  for (const m of await discoverModels(workspace, cfg)) {
    (modelIds.get(m.notation) ?? modelIds.set(m.notation, new Set()).get(m.notation)!).add(m.id);
  }
  return modelIds;
}

/** pre-flight: content repo + a path the model file guard lets through (no
 *  symlink, inside the models folder, not in .git: workspace-paths.ts
 *  modelFileRefusal) + the file exists, as typed errors BEFORE any doc work.
 *  Returns the workspace root and the file on disk. The room's load and
 *  write-through run the same guard again (collab.ts resolveRoom); the
 *  repair, which reads and writes the file itself, relies on this one. */
async function assertOnDisk(
  opts: ContentDeps,
  repo: ConnectedRepo,
  safePath: string,
): Promise<{ workspace: string; disk: string }> {
  const room = roomName(repo.fullName, safePath);
  let disk: string;
  let workspace: string;
  let models: string;
  try {
    disk = await toDiskPath(room, opts.registry, opts.workspaces, loadContentConfig);
    workspace = await opts.workspaces.ensure(repo);
    const cfg = loadContentConfig(workspace);
    if (!cfg) throw new NotAContentRepoError(repo.fullName);
    models = cfg.processes;
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof NotAContentRepoError) {
      throw new AppError("content/not-a-content-repo", message, { status: 422, expose: true });
    }
    throw new AppError("content/invalid-path", message, { status: 400, expose: true });
  }
  const refusal = modelFileRefusal(disk, workspace, models);
  if (refusal !== undefined) {
    throw new AppError(
      "content/invalid-path",
      `${safePath} ${refusal}: a model is read and saved only as a regular file inside the models folder (${models})`,
      { status: 400, expose: true },
    );
  }
  if (!existsSync(disk)) {
    throw new AppError("content/not-found", `no such file: ${safePath} (${repo.fullName})`, {
      status: 404,
      expose: true,
    });
  }
  return { workspace, disk };
}

/** per-room operation queue: Hocuspocus unloads a doc ASYNCHRONOUSLY after the
 *  last disconnect when a store is mid-flight, and createDocument happily
 *  returns a doc whose unload is in flight — so a rapid get→save on one room
 *  (the normal agent pattern) could acquire a DYING doc. Serializing our
 *  direct-connection operations per room closes the common window; the
 *  destroyed-doc retry in withDoc closes the residual one. */
const roomQueues = new Map<string, Promise<unknown>>();

/** open the room, run `fn`, ALWAYS disconnect — a leaked direct connection
 *  would pin the doc live forever (blocking sync-to-default). disconnect()
 *  also force-runs the store hook, so the write-through hits the workspace
 *  tree before the HTTP response goes out. */
async function withDoc(
  opts: ContentDeps,
  repo: ConnectedRepo,
  safePath: string,
  fn: (conn: DirectDoc) => Promise<void>,
): Promise<void> {
  const room = roomName(repo.fullName, safePath);
  return inRoomQueue(room, async () => {
    const conn = await openLive(opts, room);
    try {
      await fn(conn);
    } finally {
      await conn.disconnect();
    }
  });
}

/** run `run` in the room's operation queue (roomQueues) */
async function inRoomQueue<T>(room: string, run: () => Promise<T>): Promise<T> {
  const queued = (roomQueues.get(room) ?? Promise.resolve()).then(run, run);
  // the tail swallows the error (it propagates to THIS caller via `queued`) so
  // one failing operation never poisons the queue for the next
  const tail = queued.catch(() => undefined);
  roomQueues.set(room, tail);
  try {
    return await queued;
  } finally {
    // last waiter cleans up so the map doesn't grow with dead rooms
    if (roomQueues.get(room) === tail) roomQueues.delete(room);
  }
}

/** open with a bounded retry when the acquired doc is already being destroyed
 *  (an unload that our own previous disconnect left in flight) */
async function openLive(opts: ContentDeps, room: string): Promise<DirectDoc> {
  for (let attempt = 0; ; attempt++) {
    let conn: DirectDoc;
    try {
      conn = await opts.openDoc(room);
    } catch (e) {
      // TOCTOU backstop: file deleted between pre-flight and open
      const message = (e as Error).message;
      if (message.startsWith("no such file:")) {
        throw new AppError("content/not-found", message, { status: 404, expose: true });
      }
      if (e instanceof UnreadableDocumentError) {
        const noun = byExtension(e.path)?.noun.singular ?? "model";
        throw new AppError(
          UNREADABLE_MODEL,
          `${e.message}. It is not opened (opening it would drop what the ${noun} cannot read back) and stays ` +
            `unchanged on disk. Repair it through git, or save a valid ${noun} over it: a save with a stale ` +
            "baseVersion answers its text on disk and the baseVersion to save with.",
          { status: 422, expose: true, cause: e },
        );
      }
      throw e;
    }
    if (!conn.document?.isDestroyed) return conn;
    await conn.disconnect().catch(() => undefined);
    if (attempt >= 3) throw new Error(`room is stuck unloading: ${room}`);
    await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
  }
}
