/**
 * Which view of a document the editor shows, and what it remembers of it.
 * A notation whose plugin opts into the split view (WebNotationPlugin.splitView,
 * today Markdown) has three: the canvas layer alone (Preview), the Monaco
 * source beside it (Split), the source alone. The last choice and the
 * divider's position are kept per notation in localStorage, so the next
 * document of that notation opens the way the last one was left; the first
 * visit opens on the canvas.
 *
 * Only a CHOICE is remembered (editorViews). The shell's own fallback to the
 * source (the engine chunk failed to load, the first import failed) belongs
 * to one document: written here, it would open every later one in the source.
 *
 * Split needs room: on from SPLIT_ON_REM of editor width, off only below
 * SPLIT_OFF_REM, so a width resting at the threshold does not flip it on
 * every resize. Without the room the canvas shows, and the choice stays.
 *
 * What the shell derives from the view lives here too, so its rules are
 * tested without a browser: the layers on screen (editorLayers).
 *
 * Pure, storage a parameter (test/editor-view.test.ts), on the pattern of
 * ./repos-snapshot.ts.
 */

export type EditorView = "canvas" | "split" | "source";

const VIEWS: ReadonlySet<string> = new Set<EditorView>(["canvas", "split", "source"]);

/** bump the version when an entry changes incompatibly: old entries are then ignored */
const KEY = "designiq.editor-view.v1";

/** what a notation remembers; a field that did not hold is absent */
export interface ViewChoice {
  view?: EditorView;
  /** the divider's position: the source pane's share of the editor width, 0 to 1 */
  ratio?: number;
}

/** null: no storage, nothing remembered */
type ViewStorage = Pick<Storage, "getItem" | "setItem"> | null;

function browserStorage(): ViewStorage {
  try {
    // absent outside a browser
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked (privacy settings): nothing remembered
  }
}

/** one notation's entry, keeping only the fields that hold */
function choiceOf(value: unknown): ViewChoice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { view, ratio } = value as Record<string, unknown>;
  const choice: ViewChoice = {};
  if (typeof view === "string" && VIEWS.has(view)) choice.view = view as EditorView;
  // NaN fails both comparisons, Infinity the second
  if (typeof ratio === "number" && ratio >= 0 && ratio <= 1) choice.ratio = ratio;
  return choice.view !== undefined || choice.ratio !== undefined ? choice : undefined;
}

/** the stored choices by notation id; a damaged entry is dropped, never thrown */
export function parseViewChoices(raw: string | null | undefined): Map<string, ViewChoice> {
  const choices = new Map<string, ViewChoice>();
  if (!raw) return choices;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return choices;
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return choices;
  for (const [notationId, value] of Object.entries(stored)) {
    const choice = choiceOf(value);
    if (choice) choices.set(notationId, choice);
  }
  return choices;
}

export function serializeViewChoices(choices: ReadonlyMap<string, ViewChoice>): string {
  return JSON.stringify(Object.fromEntries(choices));
}

/** what `notationId` remembers, or nothing (no entry, unreadable, blocked storage) */
export function readViewChoice(notationId: string, storage: ViewStorage = browserStorage()): ViewChoice {
  try {
    return parseViewChoices(storage?.getItem(KEY)).get(notationId) ?? {};
  } catch {
    return {};
  }
}

/** remember a choice of `notationId`: the fields given replace the stored ones, the others stay */
export function rememberViewChoice(
  notationId: string,
  choice: ViewChoice,
  storage: ViewStorage = browserStorage(),
): void {
  try {
    if (!storage) return;
    const choices = parseViewChoices(storage.getItem(KEY));
    choices.set(notationId, { ...choices.get(notationId), ...choice });
    storage.setItem(KEY, serializeViewChoices(choices));
  } catch {
    /* quota or blocked storage: the next document opens on the default */
  }
}

/** the split view comes on at this editor width ... */
export const SPLIT_ON_REM = 48;
/** ... and goes off only below this one */
export const SPLIT_OFF_REM = 45;

/** whether the split view fits an editor `width` px wide (`rem` px to the rem), given whether it fitted until now */
export function splitFits(width: number, rem: number, fitted: boolean): boolean {
  return width >= (fitted ? SPLIT_OFF_REM : SPLIT_ON_REM) * rem;
}

/** the view on screen for the one chosen: Split shows the canvas while it has no room (or no split view) */
export function shownView(chosen: EditorView, splitAvailable: boolean): EditorView {
  return chosen === "split" && !splitAvailable ? "canvas" : chosen;
}

/** what of a document is on screen */
export interface EditorLayers {
  /** the view on screen */
  shown: EditorView;
  /** the Monaco source is on screen, alone or beside the canvas */
  sourceShown: boolean;
  /** the canvas layer is on screen, alone or beside the source */
  canvasShown: boolean;
  /** both, side by side */
  split: boolean;
}

/**
 * The layers on screen for the view chosen. A document without a visual
 * editor shows its source, a structured one its canvas (it has no text lane
 * for Monaco), and Split shows while `splitAvailable` (the plugin has the
 * split view and the editor the room), the canvas otherwise.
 */
export function editorLayers(
  view: EditorView,
  doc: { visual: boolean; structured: boolean; splitAvailable: boolean },
): EditorLayers {
  const shown = doc.structured ? "canvas" : doc.visual ? shownView(view, doc.splitAvailable) : "source";
  return { shown, sourceShown: shown !== "canvas", canvasShown: shown !== "source", split: shown === "split" };
}

/**
 * The class of a layer that is not on screen. The layer is `inert` as well
 * (the canvas behind the source view, the source pane behind the canvas),
 * which keeps it out of reach and passes a click on to the layer under it.
 * No `pointer-events: none`: the ⋯ menu opens the Miragon renderers' modal
 * dialogs (Keyboard shortcuts…, the title dialogs) inside the canvas layer in
 * the source view too, and a modal dialog escapes `inert` but inherits
 * `pointer-events`, so its Close button and its backdrop would take no click.
 */
export const HIDDEN_LAYER_CLASS = "opacity-0";

type ViewUpdate = EditorView | ((current: EditorView) => EditorView);

/**
 * The ways the editor's view changes, and which of them is remembered for
 * `notationId` (a notation with the split view; undefined: none is). Only a
 * person's choice in the view switch is. The shell's own moves belong to the
 * one document: the fallback to the source when the engine chunk or the
 * first import fails, and the canvas a reveal brings forward (a revealed
 * element must be visible: the source alone gives way, Split already shows
 * the canvas).
 */
export function editorViews(
  set: (update: ViewUpdate) => void,
  notationId: string | undefined,
  storage: ViewStorage = browserStorage(),
): { choose(view: EditorView): void; fallBack(): void; reveal(): void } {
  return {
    choose: (view) => {
      set(view);
      if (notationId !== undefined) rememberViewChoice(notationId, { view }, storage);
    },
    fallBack: () => set("source"),
    reveal: () => set((current) => (current === "source" ? "canvas" : current)),
  };
}
