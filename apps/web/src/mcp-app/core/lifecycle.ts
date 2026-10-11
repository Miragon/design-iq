/**
 * The ONE widget lifecycle — the BPMN widget's state machine (load → lazy
 * engine mount → dirty tracking → debounced CAS autosave → conflict decision →
 * newest-widget claim → progressive live upgrade → post-outage reconcile)
 * MOVED out of main.ts behind ports, so every canvas notation's widget runs
 * the same code (#156) and the node --test suite drives it without a DOM.
 * DOM-free: the runtime imports are roomName and the pure sync precedence;
 * `.ts`-extension relative imports and no "@/" alias, or node cannot load it.
 *
 * The move was verbatim except for this substitution table (review the diff
 * with `git diff -M --color-moved=dimmed-zebra`):
 *  - the chrome DOM writes → ChromePort calls (setDocument / setStatus(+tooltip)
 *    / setDirty / setSaveButton / setOpenVisible / showBanner / hideBanner)
 *  - `modeler: ModelerHandle` → `engine: E`; `todos` → `extras` (WidgetExtras)
 *  - `ref: ProcessRef` → TWO latches: `input` (the tool input, set at load
 *    START — hasLoaded) and `ref: DocRef` (set only once the load's IMPORT
 *    has landed, cleared at load start). The types force it, and a save()
 *    racing a re-load — its bridge read OR its import — now bails on `!ref`
 *    instead of PUTting the old canvas against the incoming document.
 *  - getBpmnXml / saveBpmnXml / updateModelContext → bridge.load / save / saved
 *  - tryLive(app, ref, modeler, hooks) → deps.live(ref, engine, hooks), guarded
 *    by `engine.bindLive` (a capability) and the presence of a live port
 *  - claimDocument → deps.claim; AUTOSAVE_MS / 10_000 / 100 → deps.timing
 *  - liveHooks gains onImportError (the DSL/JSON binds report it; bpmn never)
 *  - `cfg.readonly`, the deep link, the icon font and the button handlers
 *    live in widget.ts (the DOM composition)
 * Four re-delivery hazards the old code carried are closed here (each pinned
 * by a test): flushForLive is epoch-fenced, so a stale live upgrade never
 * binds the previous document's room onto the canvas of a newer load; a
 * re-load that found the previous upgrade still connecting re-attempts its
 * own once that settles; the autosave timer of an edit racing a re-load's
 * import is cleared when the import lands; and a re-delivery after a
 * supersede is ignored. A load whose import rejects keeps the deep link
 * (the read landed) and disables Save — the canvas it left is not the
 * document it names.
 *
 * The frameless chrome (spec §10.1) only ADDED to that: every state
 * transition is reported as ONE SyncState (setSync, precedence in
 * sync-view.ts), events as toasts (§5.4), the banners became decision cards
 * (title + per-choice consequence + a "decide later" pill state), the peers
 * of a live session ride setPeers, a failed autosave retries on a 5/15/60 s
 * backoff, a supersede flushes the last edit and re-mounts the canvas as a
 * viewer (flush-then-freeze), and load failures throw a staged LoadError.
 * The status texts stay as the popover's activity line.
 *
 * Everything else is unchanged on purpose — latch names and order, every
 * `epoch !== liveEpoch || inactive` re-check after an await, clearTimeout
 * BEFORE the scheduleAutosave gate, autosavePaused + clearTimeout BEFORE the
 * conflict decision, the finally re-arm on `editSeq !== seq`, the
 * `!dirty && baseVersion === fresh.baseVersion` re-import guard, the
 * byte-equal `fresh.content === replica` reconcile, the decision labels,
 * their order and `danger`. Each of them is a race that was fixed once; keep
 * them.
 */
import { roomName } from "@designiq/contracts/live";

import type { LiveEngine, WidgetEngine } from "./engine.ts";
import { findingsSummary, RESTING_STATUS, savedStatus, syncKindOf } from "./sync-view.ts";

/** tool input: the document to open. `id` resolves SERVER-side (the bridge
 *  adds the widget's notation, so a stem shared with a .bpmn opens THIS
 *  notation's file); extra tool args (a DMN scenario, one day) ride along
 *  untouched. */
export interface ModelInput extends Record<string, unknown> {
  repo: string;
  id?: string;
  path?: string;
}
/** the document the widget OWNS — the path the load resolved */
export interface DocRef {
  repo: string;
  path: string;
}
export interface LoadedModel {
  path: string;
  content: string;
  baseVersion: string;
}
export interface SaveOk {
  ok: true;
  path: string;
  baseVersion: string;
  warnings: string[];
  /** ERROR findings — present on lint:"warn" saves, where they inform */
  errors?: string[];
}
/** a retryable RESULT, never a throw (mcp.ts conflictResult) */
export interface SaveConflict {
  ok: false;
  conflict: true;
  path: string;
  currentContent: string;
  baseVersion: string;
  message: string;
}
export type SaveResult = SaveOk | SaveConflict;

/** the Live Host as the lifecycle sees it (widget.ts binds it to the app
 *  bridge: get_model_content / save_model_content / ui/update-model-context) */
export interface ModelBridge {
  load(input: ModelInput): Promise<LoadedModel>;
  /** CAS save, lint:"warn" — findings inform, never block */
  save(doc: DocRef, content: string, baseVersion: string): Promise<SaveResult>;
  /** tell the host's model the live state moved — it re-reads instead of
   *  trusting stale text */
  saved(doc: DocRef): void;
}

export interface LiveHandle {
  destroy(): void;
  /** the room state this session last knew (its local Y.Text replica) — the
   *  post-death reconcile compares it byte-for-byte with a fresh bridge read */
  snapshot(): string;
}
export interface LiveHooks {
  /** overlapping concurrent edit — the remote change won (model-sync rule 4) */
  onConflict(message: string): void;
  /** a remote snapshot did not import — the binds that take the parameter
   *  report it; bpmn's never does */
  onImportError(message: string): void;
  /** runs after sync, before the first Yjs import replaces the canvas — flush
   *  unsaved state through the bridge here; false aborts the upgrade */
  beforeBind(): Promise<boolean>;
  /** the ESTABLISHED session died: any ws drop is final, because the
   *  auto-reconnect re-sends the consumed single-use ticket and can never
   *  re-authenticate; fires at most once per session */
  onDead(): void;
  /** who else is in the room (self excluded, agents flagged) — fires after
   *  establish on every awareness change (core/live.ts) */
  onPeers?(peers: PeerLabel[]): void;
}
/** the progressive upgrade (live.ts tryLive bound to the bridge) — undefined
 *  when this host cannot go live; the caller stays on autosave */
export type LiveUpgrade = (doc: DocRef, engine: LiveEngine, hooks: LiveHooks) => Promise<LiveHandle | undefined>;

/** newest-widget-wins claim (bridge.ts claimDocument); returns the release */
export type ClaimDocument = (key: string, onSuperseded: () => void) => () => void;

// ── the chrome port ─────────────────────────────────────────────────────────

/** what the trigger, the menu header and the state cards name: provisional
 *  from the tool input at load start (`id` or `path`), resolved after the read
 *  (`path` always). The name shown is `id ?? stem(path)` (menu-model docName). */
export interface DocLabel {
  repo: string;
  path?: string;
  id?: string;
}

export type SyncKind =
  | "loading"
  | "connecting"
  | "live"
  | "reconnecting"
  | "saved"
  | "unsaved"
  | "saving"
  | "failed"
  | "paused"
  | "readonly"
  | "inactive";
/** why the widget is (not) live — picks the popover's autosave note */
export type SyncMode = "live" | "autosave-unavailable" | "autosave-by-design" | "readonly";
export interface SyncState {
  kind: SyncKind;
  /** absent until an engine is mounted */
  mode?: SyncMode;
  /** the last landed save's findings — on `saved` only */
  findings?: { errors: string[]; warnings: string[] };
  /** epoch ms of the last landed save */
  savedAt?: number;
  /** epoch ms of the next automatic retry — on `failed` only */
  retryAt?: number;
}

export interface ToastSpec {
  tone: "success" | "info" | "warning" | "danger";
  title: string;
  detail?: string;
  /** a toast WITH an action never auto-dismisses (WCAG 2.2.1) */
  action?: { label: string; run(): void };
  /** replaces a toast with the same key; dismissToast(key) clears it */
  key?: string;
}

export interface BannerAction {
  label: string;
  danger?: boolean;
  /** exactly one per card (the superseded card has none) */
  primary?: boolean;
  /** the one line beside the button: what choosing it does */
  consequence?: string;
  run(): void;
}
export interface BannerOptions {
  /** the body under the title */
  detail?: string;
  /** the card's left rule + icon — default warning */
  tone?: "warning" | "info";
  /** "Decide later" collapses the card into the pill in this state (the
   *  lifecycle's setSync already reports it); a pill click reopens it */
  deferAs?: "paused" | "inactive";
}

export interface PeerLabel {
  name: string;
  /** the peer's presence colour — UNTRUSTED (sanitize: safePresenceColor) */
  color: string;
  kind?: "human" | "agent";
}

/** the §5.3 dead ends — centred, the work chrome hidden. The lifecycle raises
 *  only `frozen-failed`; wireApp the boot and load ones (loading itself rides
 *  setSync({kind:"loading"})). `name` defaults to the last setDocument's. */
export type StateKind =
  | "booting"
  | "no-input"
  | "no-repo"
  | "bridge-failed"
  | "read-failed"
  | "import-failed"
  | "renderer-failed"
  | "frozen-failed";
export interface StateCard {
  kind: StateKind;
  name?: string;
  /** the mono error box */
  error?: string;
}

/** the chrome as the lifecycle sees it — the DOM adapter is shell.ts */
export interface ChromePort {
  /** was setTitle(text): the document named (provisional, then resolved) */
  setDocument(doc: DocLabel): void;
  /** today's status copy → the popover's activity line; `tooltip` = the
   *  findings list (written ONLY when given) */
  setStatus(text: string, tooltip?: string): void;
  /** the pill — called at every transition (deduplicated) */
  setSync(state: SyncState): void;
  /** the live roster ([] when not live) */
  setPeers(peers: PeerLabel[]): void;
  toast(t: ToastSpec): void;
  dismissToast(key: string): void;
  /** the unsaved-changes flag the menu and the popover's Save now read */
  setDirty(dirty: boolean): void;
  /** Save now availability — partial updates, merged by the adapter, which
   *  gates the menu item and the popover action on them: visible = editable
   *  autosave mode, enabled = not saving / superseded / after a failed import */
  setSaveButton(state: { visible?: boolean; enabled?: boolean }): void;
  /** the adapter ANDs the deep-link base in — no publicUrl, no Open */
  setOpenVisible(visible: boolean): void;
  /** a decision card (bottom-centre, non-modal, Escape never dismisses it).
   *  The superseded card comes with NO actions — the adapter adds "Open in
   *  designIQ" when a link can be built. */
  showBanner(title: string, actions: BannerAction[], opts?: BannerOptions): void;
  hideBanner(): void;
  /** a dead end owns the screen; undefined clears it */
  showState(card: StateCard | undefined): void;
}

/** a load that did not land: `read` = the bridge read rejected, `import` =
 *  the read landed but the canvas could not show it (or the engine mount
 *  failed). wireApp picks the state card by the stage. */
export class LoadError extends Error {
  readonly stage: "read" | "import";
  constructor(stage: "read" | "import", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "LoadError";
    this.stage = stage;
  }
}

/** notation-only chrome mounted ONCE with the engine and BEFORE the first
 *  read lands (bpmn: todos + the t.BPM switch — the todo canvas re-renders its
 *  badges on every import.done, the live re-imports included) */
export interface WidgetExtras {
  /** the document is known (path resolved) — fires right after the bridge
   *  read, in parallel with the import, or at load START when the tool input
   *  already carries the path; the discovery calls (list_todos, the decision
   *  tests) start here */
  onRead?(doc: DocRef, input: ModelInput): void;
  /** the document now open (+ the tool input it came from) — after every
   *  successful load import */
  onDocument(doc: DocRef, input: ModelInput): void;
  /** an autosave or Save now landed (dmn: the Checks card re-checks the
   *  stored decision); never after destroy — the superseded flush included */
  onSaved?(doc: DocRef): void;
  /** superseded by a newer widget — tear down; never called twice */
  destroy(): void;
}

export interface LifecycleTiming {
  autosaveMs?: number;
  flushDeadlineMs?: number;
  flushPollMs?: number;
  /** the automatic retries after a failed autosave; then the next edit or a manual Retry */
  retryMs?: number[];
}

export interface LifecycleDeps<E extends WidgetEngine> {
  readonly: boolean;
  /** status copy: "Loading <noun>…" (bpmn passes "model" — today's strings) */
  noun: string;
  /** mounts the engine into the caller's container — the editor (or the
   *  boot-flag viewer) on the FIRST load, a viewer (`true`) for the
   *  superseded freeze */
  mountEngine: (readonly: boolean) => E;
  bridge: ModelBridge;
  /** absent = never attempt the upgrade (a host without tickets) */
  live?: LiveUpgrade;
  claim: ClaimDocument;
  chrome: ChromePort;
  extras?: (engine: E) => WidgetExtras;
  /** after every mount — the first one and the superseded freeze (`frozen`);
   *  the chrome re-binds engine.view (zoom, Tools) here */
  onMount?: (engine: E, frozen: boolean) => void;
  /** test seams — production keeps the defaults */
  timing?: LifecycleTiming;
}

export interface LifecycleState {
  dirty: boolean;
  live: boolean;
  inactive: boolean;
  /** a decision (or the post-outage reconcile) owns the next step — autosave
   *  and flushOnLeave are paused */
  paused: boolean;
  saving: boolean;
  /** the last save threw and has not landed since */
  failed: boolean;
  baseVersion: string;
}

export interface WidgetLifecycle<E extends WidgetEngine> {
  /** a (re)delivered tool input — bumps the epoch, releases the old claim,
   *  tears down live state, timers and decisions, then owns the widget.
   *  Rejects with a LoadError when the read or the import fails. */
  load(input: ModelInput): Promise<void>;
  /** the explicit "Save now" (menu, ⌘S, popover, Retry) — the same save the
   *  autosave timer runs, plus a "Saved" toast; in live mode, or with nothing
   *  to save, an info toast and no PUT */
  save(): Promise<void>;
  /** "Open in designIQ" leaves the chat: `if (dirty && !live) void save()` —
   *  paused under a decision on purpose (the card owns the divergence) */
  flushOnLeave(): void;
  /** teardown (app.onteardown): waits for an in-flight save, then flushes a
   *  pending autosave when dirty && !live && !paused */
  flushNow(): Promise<void>;
  /** "Reload latest version": the tool input again, through load() — the same
   *  epoch fencing; unsaved edits are discarded (the menu confirms first). A
   *  save in flight lands first, so the read sees it. */
  reload(): Promise<void>;
  /** the tool input of the latest load (Try again) */
  lastInput(): ModelInput | undefined;
  /** true once tool input arrived (set at load START) — wireApp's no-input guard */
  hasLoaded(): boolean;
  /** the document a save may PUT against — undefined until the load's import landed */
  document(): DocRef | undefined;
  /** the document the widget shows or is loading — the deep-link target;
   *  known from the bridge read on, i.e. before (and despite a failed) import */
  linkTarget(): DocRef | undefined;
  engine(): E | undefined;
  state(): LifecycleState;
  /** the pill state last reported (setSync) */
  sync(): SyncState;
}

export const AUTOSAVE_MS = 1500;
export const FLUSH_DEADLINE_MS = 10_000;
export const FLUSH_POLL_MS = 100;
export const RETRY_MS = [5000, 15_000, 60_000];

interface SaveOptions {
  /** replay an EARLIER serialization ("Overwrite anyway") */
  text?: string;
  version?: string;
  seq?: number;
  /** a user asked for it — a success says so */
  explicit?: boolean;
  /** the pre-bind flush loop retries by itself — no backoff timer */
  flush?: boolean;
  /** replaces the explicit "Saved" toast */
  successToast?: ToastSpec;
}

export function createWidgetLifecycle<E extends WidgetEngine>(deps: LifecycleDeps<E>): WidgetLifecycle<E> {
  const { chrome, bridge } = deps;
  const autosaveMs = deps.timing?.autosaveMs ?? AUTOSAVE_MS;
  const flushDeadlineMs = deps.timing?.flushDeadlineMs ?? FLUSH_DEADLINE_MS;
  const flushPollMs = deps.timing?.flushPollMs ?? FLUSH_POLL_MS;
  const retryMs = deps.timing?.retryMs ?? RETRY_MS;

  let engine: E | undefined;
  let extras: WidgetExtras | undefined; // notation chrome (bpmn: todos) — absent for the others
  let input: ModelInput | undefined; // tool input arrived — set at load START (hasLoaded)
  let loaded: DocRef | undefined; // what the bridge read resolved — the deep-link target
  let ref: DocRef | undefined; // the document a save may PUT against — set once the import landed
  let baseVersion = "";
  let inactive = false; // superseded by a newer widget — stop all saving
  let live: LiveHandle | undefined; // Yjs session — when set, autosave is off
  let dirty = false; // authoritative unsaved-changes flag (the pill mirrors it)
  let editSeq = 0; // bumps on every canvas edit — save() detects mid-flight edits
  let liveEpoch = 0; // bumps on every load() — stale async continuations bail out
  let upgradingLive = false; // single-flight guard for upgradeToLive
  let releaseClaim: (() => void) | undefined; // undo of the current claimDocument

  // ── the pill's inputs (sync-view.ts picks ONE kind from them) ──
  let loading = false; // a load's import has not landed
  let decision = false; // a decision card owns the next step (shown or deferred)
  let reconnecting = false; // the live session died, the reconcile runs
  let failed = false; // the last save threw
  let failures = 0; // consecutive failed autosaves — indexes the backoff
  let retryAt: number | undefined;
  let findings: { errors: string[]; warnings: string[] } | undefined;
  let findingsCount = 0; // a rise toasts once
  let savedAt: number | undefined;
  let inflight: Promise<void> | undefined; // the save in flight (flushNow / supersede wait on it)
  let lastSync = "";
  let current: SyncState = { kind: "loading" };

  const setDirty = (d: boolean): void => {
    dirty = d;
    chrome.setDirty(d);
  };

  /** the failed-save state ends — a landed save, a round trip that came back
   *  (a conflict: its card owns the next step), a load, the superseded stop.
   *  Its toast goes with it, and the next failure backs off from the start. */
  function clearFailed(): void {
    if (failed) chrome.dismissToast("save-failed");
    failed = false;
    failures = 0;
    retryAt = undefined;
  }

  function modeNow(): SyncMode | undefined {
    if (!engine) return deps.readonly ? "readonly" : undefined;
    if (deps.readonly || !engine.editable) return "readonly";
    if (live) return "live";
    return engine.bindLive && deps.live ? "autosave-unavailable" : "autosave-by-design";
  }

  /** report the pill state — at every transition, deduplicated */
  function syncNow(): void {
    const kind = syncKindOf({
      loading,
      inactive,
      readonly: deps.readonly || engine?.editable === false,
      decision,
      failed,
      reconnecting,
      saving,
      dirty,
      connecting: upgradingLive,
      live: live !== undefined,
    });
    const mode = modeNow();
    const next: SyncState = { kind, ...(mode ? { mode } : {}) };
    if (kind === "saved" && findings) next.findings = findings;
    if (savedAt !== undefined) next.savedAt = savedAt;
    if (kind === "failed" && retryAt !== undefined) next.retryAt = retryAt;
    const key = JSON.stringify(next);
    if (key === lastSync) return;
    lastSync = key;
    current = next;
    chrome.setSync(next);
  }

  // ── autosave: the widget behaves like a live room — every pause in modelling
  // persists; findings inform, never block. Paused while a decision card is up
  // (the timer must not race the user's decision).
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let autosavePaused = false;
  let saving = false;
  function scheduleAutosave(ms = autosaveMs): void {
    // clear BEFORE the gate: a schedule attempt while paused/live must also
    // kill a zombie timer armed earlier, not leave it racing the decision
    clearTimeout(autosaveTimer);
    if (inactive || autosavePaused || live) return; // live mode: Yjs persists continuously
    autosaveTimer = setTimeout(() => {
      void save();
    }, ms);
  }

  /** non-blocking findings display — the pill, the popover rows, the status
   *  line (+ tooltip), and ONE warning toast when the count rises (true: it
   *  toasted). The words are sync-view's, so status and pill label match. */
  function showFindings(errors: string[] | undefined, warnings: string[]): boolean {
    const count = (errors?.length ?? 0) + warnings.length;
    findings = count > 0 ? { errors: errors ?? [], warnings } : undefined;
    chrome.setStatus(savedStatus(findings), [...(errors ?? []), ...warnings].join("\n"));
    const rose = count > findingsCount;
    if (rose && findings) {
      chrome.toast({
        tone: "warning",
        title: `Saved with ${findingsSummary(findings, " and ")}`,
        detail: errors?.[0] ?? warnings[0],
        key: "findings",
      });
    }
    findingsCount = count;
    return rose;
  }

  /** a decision card owns the next step (autosavePaused is the caller's) */
  function showDecision(title: string, actions: BannerAction[], opts: BannerOptions): void {
    decision = true;
    chrome.showBanner(title, actions, opts);
    syncNow();
  }
  function clearDecision(): void {
    decision = false;
    chrome.hideBanner();
  }

  /** first mount: the editor (or the boot-flag viewer) plus the extras */
  function mountFirst(): E {
    const e = deps.mountEngine(deps.readonly);
    e.onDirty(() => {
      if (live) return; // Yjs already persisted the change
      // superseded: still counted — the final flush must see an edit made
      // after its export (the chrome makes the canvas inert meanwhile)
      editSeq++;
      setDirty(true);
      scheduleAutosave();
      syncNow();
    });
    chrome.setSaveButton({ visible: e.editable });
    // notation chrome, bound BEFORE the first import (bpmn: the todo canvas
    // re-renders its badges on every `import.done`, incl. the live re-imports)
    extras = deps.extras?.(e);
    deps.onMount?.(e, false);
    return e;
  }

  async function load(next: ModelInput): Promise<void> {
    // defensive against out-of-contract hosts re-delivering tool input: this
    // load owns the widget from here. Bump the epoch (stale async continuations
    // — pending upgrades, decision actions, an OLDER load — bail out on it),
    // release the old claim (re-claiming without releasing supersedes OURSELVES
    // via the BroadcastChannel), and tear down live state, timers and cards.
    // A superseded instance stays inactive: a re-delivery must not hide its
    // card or restart a load that could never save.
    if (inactive) return;
    const epoch = ++liveEpoch;
    releaseClaim?.();
    releaseClaim = undefined;
    if (live) chrome.setPeers([]);
    live?.destroy();
    live = undefined;
    clearTimeout(autosaveTimer);
    clearDecision();
    autosavePaused = false;
    reconnecting = false;
    clearFailed();
    findings = undefined;
    findingsCount = 0;
    savedAt = undefined;
    input = next;
    // `input` names the INCOMING document while the canvas still shows the old
    // one — no deep link (and no flush, no save) until the read lands
    loaded = undefined;
    ref = undefined;
    loading = true;
    chrome.setOpenVisible(false);
    chrome.setDocument({
      repo: next.repo,
      ...(next.id !== undefined ? { id: next.id } : {}),
      ...(next.path !== undefined ? { path: next.path } : {}),
    });
    chrome.setStatus(`Loading ${deps.noun}…`);
    // every load START reports loading, even after a failed load left the
    // pill on it — the chrome swaps its failure card back to "Loading…"
    lastSync = "";
    syncNow();
    // the FIRST load mounts the engine (and the extras) right away, so the
    // discovery calls can start in parallel with the read
    if (!engine) {
      try {
        engine = mountFirst();
      } catch (err) {
        throw new LoadError("import", err);
      }
    }
    if (next.path) extras?.onRead?.({ repo: next.repo, path: next.path }, next);
    let read: LoadedModel;
    try {
      read = await bridge.load(next);
    } catch (err) {
      // a newer load owns the widget — its own outcome speaks, not this one
      if (epoch !== liveEpoch || inactive) return;
      throw new LoadError("read", err);
    }
    if (epoch !== liveEpoch || inactive) return; // a newer load owns the widget
    loaded = { repo: next.repo, path: read.path };
    chrome.setDocument({ repo: next.repo, path: read.path, ...(next.id !== undefined ? { id: next.id } : {}) });
    // a read model has a web address — even for a later-superseded instance,
    // and even when its import fails below, the deep link stays the most
    // useful remaining control
    chrome.setOpenVisible(true);
    baseVersion = read.baseVersion;
    if (read.path !== next.path) extras?.onRead?.(loaded, next);
    try {
      await engine.importText(read.content);
    } catch (err) {
      // the canvas still shows the PREVIOUS document (or nothing) while the
      // title names the new one — no save may leave from here (ref stays
      // unset), and Save now must say so; the caller shows the state card
      if (epoch !== liveEpoch || inactive) return;
      chrome.setSaveButton({ enabled: false });
      throw new LoadError("import", err);
    }
    if (epoch !== liveEpoch || inactive) return; // a newer load owns the widget
    // the load OWNS the widget from here: only now may a save PUT against this
    // document — an edit racing the import above found no `ref` and bailed,
    // and its timer must not fire into the freshly landed canvas either
    ref = loaded;
    loading = false;
    clearTimeout(autosaveTimer);
    setDirty(false);
    chrome.setSaveButton({ visible: engine.editable, enabled: true });
    // the extras of THIS document — a failing/absent tracker never blocks the model
    extras?.onDocument(loaded, next);
    releaseClaim = deps.claim(roomName(next.repo, read.path), () => void supersede());
    chrome.setStatus(deps.readonly ? RESTING_STATUS.readonly : RESTING_STATUS.ready);
    syncNow();

    // progressive upgrade to the live Yjs session (the web SPA's co-editing
    // path): on success autosave retires — the CRDT persists every edit and
    // remote changes appear as they happen. Any failure leaves autosave on.
    // beforeBind (flushForLive) persists unsaved canvas state before the first
    // Yjs import may replace the canvas.
    if (engine.editable) await upgradeToLive();
  }

  /** attempt the live upgrade; on success autosave retires (timer cleared,
   *  Save now hidden). Unsaved canvas state is safe: tryLive's beforeBind
   *  flushes it before the first Yjs import. Failure leaves autosave on. */
  async function upgradeToLive(): Promise<void> {
    if (!engine || !ref || !engine.editable || inactive || live || upgradingLive) return;
    // live is a capability: an engine without a binding (or a host without
    // tickets) stays on CAS autosave — the DMN widget's deliberate mode
    if (!engine.bindLive || !deps.live) return;
    upgradingLive = true;
    syncNow();
    const epoch = liveEpoch;
    try {
      const handle = await deps.live(ref, engine as E & LiveEngine, liveHooks(epoch));
      if (!handle) return;
      if (inactive || epoch !== liveEpoch || live) {
        // superseded or re-loaded while connecting (the claim callback / the
        // next load ran before `live` was assigned) — tear the session down
        handle.destroy();
        return;
      }
      live = handle;
      clearTimeout(autosaveTimer);
      clearFailed(); // the flush landed everything — the room holds it now
      chrome.setSaveButton({ visible: false });
      setDirty(false);
      chrome.setStatus(RESTING_STATUS.live);
    } finally {
      upgradingLive = false;
      syncNow();
      // a re-load landed while this attempt was connecting and bailed on the
      // single-flight guard — attempt it for the document that owns the
      // widget now, or it would stay on autosave for good
      if (epoch !== liveEpoch && !inactive && ref && !live) void upgradeToLive();
    }
  }

  /** hooks shared by every live upgrade attempt (initial load + reconnects);
   *  `epoch` is the attempt's — the flush vetoes the bind once a re-load
   *  superseded the attempt, however late the sync arrives */
  function liveHooks(epoch: number): LiveHooks {
    const isCurrent = (): boolean => epoch === liveEpoch && !inactive;
    return {
      onConflict: (msg) => {
        chrome.setStatus(`Sync conflict: ${msg}`);
        if (isCurrent())
          chrome.toast({ tone: "warning", title: "A remote edit won an overlapping change", detail: msg });
      },
      onImportError: (msg) => {
        chrome.setStatus(`Live import failed: ${msg}`);
        if (isCurrent()) chrome.toast({ tone: "danger", title: "Live import failed", detail: msg });
      },
      beforeBind: () => flushForLive(epoch),
      onDead: () => void onLiveDead(),
      onPeers: (peers) => {
        if (isCurrent()) chrome.setPeers(peers);
      },
    };
  }

  /** the first Yjs import replaces the canvas — flush unsaved state through the
   *  normal CAS save first so nothing is lost; false aborts the upgrade */
  async function flushForLive(epoch: number): Promise<boolean> {
    // epoch-fenced by the ATTEMPT's epoch: a re-load that landed while this
    // upgrade was connecting must veto the bind — the room about to be bound
    // belongs to the PREVIOUS document, and its first Yjs import would
    // replace the new canvas
    const deadline = Date.now() + flushDeadlineMs;
    while (epoch === liveEpoch && !inactive && !autosavePaused && (saving || dirty)) {
      if (Date.now() > deadline) {
        // give up on the UPGRADE only — autosave keeps retrying the edit (a
        // loop held up by a stale save alone has nothing to retry)
        if (dirty) scheduleAutosave();
        return false;
      }
      if (!saving) await save({ flush: true });
      await new Promise((r) => setTimeout(r, flushPollMs));
    }
    return epoch === liveEpoch && !inactive && !autosavePaused;
  }

  /** live sync ended — the pill drops back to autosave, the user hears it once */
  function backToAutosave(): void {
    chrome.setSaveButton({ visible: true });
    chrome.setStatus("Live sync lost — changes save automatically");
    chrome.toast({ tone: "info", title: "Live sync lost — changes now save automatically" });
  }

  /** the established live session died (any ws drop or doc-level close is
   *  final — the single-use ticket cannot re-authenticate the provider's
   *  auto-reconnect). Persistence must never stop silently: reconcile against
   *  a fresh bridge read, then either resume live with a fresh ticket or hand
   *  the decision to the user. */
  async function onLiveDead(): Promise<void> {
    const epoch = liveEpoch;
    const replica = live?.snapshot(); // the room state this session last knew
    if (live) chrome.setPeers([]);
    live?.destroy();
    live = undefined;
    if (inactive || !engine || !ref) return;
    const doc = ref;
    chrome.setStatus("Live sync lost — reconnecting…");
    // gate edits made during the reconcile: a save against the pre-death token
    // would be refused anyway (the live session moved the version) and its
    // conflict decision would fight the reconcile's own
    autosavePaused = true;
    reconnecting = true;
    clearTimeout(autosaveTimer);
    syncNow();
    let fresh: LoadedModel;
    try {
      fresh = await bridge.load({ repo: doc.repo, path: doc.path });
    } catch {
      if (epoch !== liveEpoch || inactive) return;
      // even the bridge is down: keep the stale token — the next save's CAS
      // conflict decision hands the choice to the user
      autosavePaused = false;
      reconnecting = false;
      editSeq++;
      setDirty(true);
      backToAutosave();
      scheduleAutosave();
      syncNow();
      return;
    }
    if (epoch !== liveEpoch || inactive) return;
    if (fresh.content === replica) {
      // the server holds exactly what this session last knew — nothing is
      // unsaved in either direction (shared byte lineage, so formatting can't
      // false-positive), and a fresh ticket resumes live seamlessly
      baseVersion = fresh.baseVersion;
      autosavePaused = false;
      await upgradeToLive();
      if (epoch !== liveEpoch || inactive) return;
      reconnecting = false;
      if (!live) {
        // the canvas can lag the replica by a remote op still inside the
        // import debounce at death — reconcile it to the fresh state, or the
        // next canvas save would silently revert that op. ONLY safe while the
        // canvas is clean and unsaved-against-fresh: an edit made during the
        // upgrade attempt (dirty, or already flushed → baseVersion moved) must
        // win instead — its canvas is newer than `fresh`. (Residual: such an
        // edit racing a colleague op that was still inside the debounce at
        // death keeps the canvas's side — same class as the documented
        // model-sync import-window race.)
        if (!dirty && baseVersion === fresh.baseVersion) {
          try {
            await engine.importText(fresh.content);
          } catch {
            // unimportable snapshot — let the user decide instead of guessing
            if (epoch !== liveEpoch || inactive) return;
            autosavePaused = true;
            chrome.setSaveButton({ visible: true });
            onLiveInterrupted(fresh);
            return;
          }
          if (epoch !== liveEpoch || inactive) return;
          setDirty(false);
        } else if (dirty) {
          scheduleAutosave();
        }
        backToAutosave();
      }
      syncNow();
      return;
    }
    // the room moved during the outage (a colleague), local edits never reached
    // it, or both — direction-blind, so the USER decides; never overwrite
    // either side silently
    reconnecting = false;
    chrome.setSaveButton({ visible: true });
    onLiveInterrupted(fresh); // keeps autosavePaused=true — the card owns it
  }

  /** post-outage divergence — mirrors the CAS conflict flow: the card owns the
   *  next step, autosavePaused until a choice is made */
  function onLiveInterrupted(fresh: { content: string; baseVersion: string }): void {
    const epoch = liveEpoch; // a re-load invalidates these closures wholesale
    chrome.setStatus("Live sync interrupted");
    showDecision(
      "Live sync was interrupted",
      [
        {
          label: "Load server version",
          primary: true,
          consequence: "This canvas switches to the server copy and goes live again.",
          run: () => {
            if (epoch !== liveEpoch || inactive) return;
            void (async () => {
              clearDecision();
              try {
                await engine?.importText(fresh.content);
              } catch {
                // the server snapshot didn't import — keep MY canvas and re-ask
                if (epoch !== liveEpoch || inactive) return;
                onLiveInterrupted(fresh);
                return;
              }
              if (epoch !== liveEpoch || inactive) return;
              baseVersion = fresh.baseVersion;
              setDirty(false);
              autosavePaused = false;
              chrome.setStatus("Reloaded — changes save automatically");
              chrome.toast({ tone: "info", title: "Loaded the server version" });
              syncNow();
              void upgradeToLive();
            })();
          },
        },
        {
          label: "Keep my canvas",
          danger: true,
          consequence: "Autosave writes this canvas over the server copy.",
          run: () => {
            if (epoch !== liveEpoch || inactive) return;
            clearDecision();
            baseVersion = fresh.baseVersion;
            autosavePaused = false;
            editSeq++;
            setDirty(true);
            chrome.setStatus("Keeping this canvas — autosave will overwrite the server version");
            chrome.toast({ tone: "info", title: "Keeping this canvas — autosave will overwrite the server version" });
            scheduleAutosave();
            syncNow();
          },
        },
      ],
      {
        detail: "The server copy differs from this canvas. Autosave is paused until you choose.",
        tone: "warning",
        deferAs: "paused",
      },
    );
  }

  /** a save threw (token expiry, network): keep the model, retry on the
   *  5 s / 15 s / 60 s backoff, then on the next edit or a manual Retry */
  function onSaveFailed(message: string, flush: boolean): void {
    failed = true;
    const delay = flush ? undefined : retryMs[failures++];
    retryAt = delay !== undefined ? Date.now() + delay : undefined;
    const automatic = delay !== undefined || flush;
    chrome.setStatus(
      `Autosave failed: ${message} — ${automatic ? "retrying automatically" : "retrying on the next change"}`,
    );
    const next =
      delay !== undefined
        ? `trying again in ${Math.round(delay / 1000)} s.`
        : flush
          ? "trying again shortly."
          : "the next edit tries again.";
    chrome.toast({
      tone: "danger",
      title: "Autosave failed",
      detail: `${message.replace(/\.$/, "")}. Your edits stay on this canvas — ${next}`,
      action: { label: "Retry now", run: () => void save({ explicit: true }) },
      key: "save-failed",
    });
    if (delay !== undefined) scheduleAutosave(delay);
  }

  async function save(o: SaveOptions = {}): Promise<void> {
    if (!engine || !ref || inactive || saving || live || autosavePaused) return;
    const doc = ref;
    saving = true;
    clearTimeout(autosaveTimer);
    chrome.setSaveButton({ enabled: false });
    // an override replays an EARLIER serialization — pair it with the seq from
    // that moment, or a mid-flight edit would be marked saved without being sent
    const seq = o.seq ?? editSeq;
    const epoch = liveEpoch; // a re-load mid-flight orphans this save entirely
    let settle!: () => void;
    inflight = new Promise<void>((r) => (settle = r));
    syncNow();
    try {
      const text = o.text ?? (await engine.exportText());
      // re-loaded during the serialization: the widget now names a NEW
      // document — never PUT the old canvas there
      if (epoch !== liveEpoch) return;
      chrome.setStatus(RESTING_STATUS.saving);
      // no validate preflight: lint:"warn" saves like a live room and reports
      // findings on the result — one round-trip, nothing blocks
      const result = await bridge.save(doc, text, o.version ?? baseVersion);
      if (epoch !== liveEpoch) return; // stale result — the new load owns state
      if (inactive) {
        // superseded mid-flight: record a landed save for the final flush,
        // raise nothing — the superseded card owns the screen
        if (result.ok) {
          baseVersion = result.baseVersion;
          if (editSeq === seq) setDirty(false);
          bridge.saved(doc);
        }
        return;
      }
      if (!result.ok) {
        // the round trip worked — no retry is coming: the card owns the next step
        clearFailed();
        autosavePaused = true; // no timer racing the decision
        clearTimeout(autosaveTimer); // incl. one armed by a mid-flight edit
        onConflict(result, text, seq);
        return;
      }
      baseVersion = result.baseVersion;
      if (editSeq === seq) setDirty(false); // a mid-flight edit keeps Unsaved on
      const recovered = failed; // the pill's way back from "Not saved" says "Saved"
      clearFailed();
      savedAt = Date.now();
      const toasted = showFindings(result.errors, result.warnings);
      // one surface per transition: the findings toast or the recovering pill
      // already speaks for an explicit save
      if (o.successToast) chrome.toast(o.successToast);
      else if (o.explicit && !toasted && !recovered) chrome.toast({ tone: "success", title: "Saved" });
      // tell the model the live state moved — it re-reads instead of trusting stale text
      bridge.saved(doc);
      extras?.onSaved?.(doc);
    } catch (err) {
      if (epoch === liveEpoch && !inactive) onSaveFailed((err as Error).message, o.flush === true);
    } finally {
      saving = false;
      inflight = undefined;
      settle();
      chrome.setSaveButton({ enabled: !inactive }); // a superseded instance stays disabled
      // an edit made while this save was in flight is NOT in the payload just
      // sent — its own timer may also have fired into the `saving` guard above,
      // so re-arm here or it would sit unsaved behind a false "Saved"
      if (epoch === liveEpoch && editSeq !== seq) scheduleAutosave();
      syncNow();
    }
  }

  function onConflict(conflict: SaveConflict, myText: string, mySeq: number): void {
    const epoch = liveEpoch; // a re-load invalidates these closures wholesale
    chrome.setStatus("Conflict — autosave paused");
    showDecision(
      "Someone saved this model in the meantime.",
      [
        {
          label: "Load their version",
          primary: true,
          consequence: "Your last change is discarded.",
          run: () => {
            if (epoch !== liveEpoch || inactive) return;
            void (async () => {
              clearDecision();
              try {
                await engine?.importText(conflict.currentContent);
              } catch {
                // their snapshot didn't import (e.g. transiently invalid mid-edit
                // text) — keep MY canvas and hand the decision back
                if (epoch !== liveEpoch || inactive) return;
                onConflict(conflict, myText, mySeq);
                return;
              }
              if (epoch !== liveEpoch || inactive) return;
              baseVersion = conflict.baseVersion;
              setDirty(false);
              autosavePaused = false;
              chrome.setStatus("Reloaded");
              chrome.toast({ tone: "info", title: "Loaded their version" });
              syncNow();
            })();
          },
        },
        {
          label: "Overwrite anyway",
          danger: true,
          consequence: "Their change is replaced right away.",
          // resend MY text against the FRESH token — CAS passes, their edit loses.
          // mySeq travels along: an edit made after myText was serialized keeps
          // Unsaved on and re-arms autosave instead of being marked saved.
          run: () => {
            if (epoch !== liveEpoch || inactive) return;
            clearDecision();
            autosavePaused = false;
            void save({
              text: myText,
              version: conflict.baseVersion,
              seq: mySeq,
              successToast: { tone: "success", title: "Saved — your version replaced theirs" },
            });
          },
        },
        {
          label: "Keep editing",
          consequence: "Your next autosave replaces their change.",
          run: () => {
            // keep MY state and persist it — the status promises the next save
            // overwrites theirs, so arm it instead of waiting for another edit
            if (epoch !== liveEpoch || inactive) return;
            clearDecision();
            baseVersion = conflict.baseVersion;
            autosavePaused = false;
            chrome.setStatus("Editing on — autosave will overwrite their version");
            chrome.toast({ tone: "info", title: "Editing on — your next autosave replaces their version" });
            // only an edit is persisted over theirs — a clean canvas just adopts the token
            if (dirty || mySeq !== editSeq) scheduleAutosave();
            syncNow();
          },
        },
      ],
      { detail: "Autosave is paused until you choose.", tone: "warning", deferAs: "paused" },
    );
  }

  /**
   * A newer widget claimed the document: flush-then-freeze (spec §6.6). Stop
   * everything, run ONE last CAS save of a pending edit (its outcome joins the
   * card), then re-mount the canvas as a viewer — no touch, context-pad or
   * keyboard edit can reach a dead instance (a veil could not promise that).
   * The viewer shows what was SAVED when the flush ran: an edit that slipped
   * in during the round trip is named on the card, never shown as stored.
   * An edit a decision (or the live reconcile) held back is not flushed — the
   * card says it was lost. The final save may surface as a CAS conflict in
   * the NEWER widget: honest, and preferable to silent loss.
   */
  async function supersede(): Promise<void> {
    if (inactive) return;
    const pending = inflight;
    const wasLive = live !== undefined;
    const wasPaused = autosavePaused; // a decision (or a reconcile) owned the edit
    const wasReconnecting = reconnecting;
    inactive = true;
    clearTimeout(autosaveTimer);
    clearFailed(); // no "trying again" under the superseded card
    if (wasLive) chrome.setPeers([]);
    live?.destroy();
    live = undefined;
    extras?.destroy();
    extras = undefined;
    decision = false; // the superseded card replaces any open decision
    chrome.setSaveButton({ enabled: false });
    const body = "This copy is read-only now. Keep working in the newest widget in this chat.";
    const card = (note?: string): void =>
      chrome.showBanner("This model is open in a newer widget", [], {
        detail: note ? `${body} ${note}` : body,
        tone: "info",
        deferAs: "inactive",
      });
    card();
    syncNow();
    const old = engine;
    if (!old) return;
    if (pending) await pending; // an in-flight save lands (or not) first
    /** the canvas the final flush exported — the viewer shows exactly that */
    let flushed: string | undefined;
    if (dirty && !wasLive && !wasPaused && old.editable && ref) {
      const doc = ref;
      let note: string;
      const seq = editSeq;
      try {
        flushed = await old.exportText();
        const result = await bridge.save(doc, flushed, baseVersion);
        if (result.ok) {
          baseVersion = result.baseVersion;
          bridge.saved(doc);
          if (editSeq === seq) {
            setDirty(false);
            note = "Your last change was saved before this copy stopped.";
          } else {
            note =
              "An earlier change was saved, but your latest one came in while this copy stopped and was not. Redo it in the newest widget.";
          }
        } else {
          note = `Your last change could not be saved: ${result.message}`;
        }
      } catch (err) {
        note = `Your last change could not be saved: ${(err as Error).message}`;
      }
      card(note);
    } else if (dirty && !wasLive && wasPaused) {
      // never flushed (the spec): the decision owned it — but never silently lost
      card(
        wasReconnecting
          ? "Your unsaved change was not saved — it was waiting for live sync to recover. Redo it in the newest widget."
          : "Your unsaved change was not saved — it was waiting for your decision. Redo it in the newest widget.",
      );
    }
    if (!old.editable) return; // a viewer is frozen already
    // the editor goes either way — a dead instance must not stay editable
    let text = flushed;
    let error: unknown;
    if (text === undefined) {
      try {
        text = await old.exportText();
      } catch (err) {
        error = err;
      }
    }
    old.destroy();
    engine = undefined;
    try {
      if (text === undefined) throw error;
      const frozen = deps.mountEngine(true);
      engine = frozen;
      deps.onMount?.(frozen, true);
      await frozen.importText(text);
    } catch (err) {
      chrome.showState({ kind: "frozen-failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** "Open in designIQ": a still-unsaved edit follows in parallel — REST saves
   *  land in the very live document the opened web editor joins (in live mode
   *  Yjs has already persisted everything). While a decision card is up,
   *  save() stays paused on purpose — the opened editor then shows the SERVER
   *  version and the card keeps owning the decision. */
  function flushOnLeave(): void {
    if (dirty && !live) void save();
  }

  async function flushNow(): Promise<void> {
    if (inflight) await inflight;
    if (dirty && !live && !autosavePaused && !inactive) await save();
  }

  return {
    load,
    save: async () => {
      if (!engine?.editable || inactive) return;
      if (live) {
        chrome.toast({ tone: "info", title: "Live sync already saves every edit" });
        return;
      }
      // ⌘S on a clean canvas: nothing to PUT — a stale canvas sent against a
      // colleague's newer save would raise a conflict over changes never made
      // (a failed save is always dirty: its Retry passes)
      if (!dirty && !failed) {
        chrome.toast({ tone: "info", title: "All changes saved" });
        return;
      }
      await save({ explicit: true });
    },
    flushOnLeave,
    flushNow,
    reload: async () => {
      // a save in flight lands first: a read answered before it would pin the
      // pre-save version, and the dropped result would leave the next edit a
      // conflict against the user's own save
      if (inflight) await inflight;
      if (input) await load(input);
    },
    lastInput: () => input,
    hasLoaded: () => input !== undefined,
    document: () => ref,
    linkTarget: () => loaded,
    engine: () => engine,
    state: () => ({ dirty, live: live !== undefined, inactive, paused: autosavePaused, saving, failed, baseVersion }),
    sync: () => current,
  };
}
