/**
 * Entry of board-spike-embed.html, the page an iframe node of the board shows (iframe strategy):
 * ONE product editor that fills the window, mounted by the PRODUCT's own mount function and bound
 * to this frame's replica of the file. Nothing of an engine is copied or patched. What the page
 * adds is the hub connection, a host element with the notation's canvas class, the smallest
 * EditorContext, and the board's arm / disarm.
 *
 *   ?frame=<name>&file=<path>&notation=<id>     (shared.ts: embedUrl, readEmbedParams)
 *   &via=registry                               mount through the SPA's plugin registry instead
 *
 * The product hands back a MountedEditor (focus, destroy, the todo surface) and never the engine:
 * the page learns that the first import is through from the DOM, and drops a selection the way a
 * person does, with a click on the empty canvas. In preview it keeps no focus: what takes it here
 * (diagram-js, when a popup menu closes) loses it again at once.
 */
// first, before anything else of this frame runs: the browser's own geometry functions for the measurements
import "./native-geometry.ts";
import "./page-styles.ts";

import type { EditorContext, MountedEditor } from "@/notations/registry";

import { createProbe } from "../notations/board/probe.ts";
import { productMount, type Via, viaOf } from "../notations/board/product-mount.ts";
import { connectToHub } from "./model-hub.ts";
import { EMBED_KEY, type EmbedHooks, type EmbedParams, readEmbedParams } from "./shared.ts";

/** ms since this frame's navigation start (performance.now()); `timeOrigin` places them on the board page's clock */
export interface EmbedTimings {
  timeOrigin: number;
  /** the hub's state is applied to the replica */
  connected?: number;
  /** the product's mount function returned its MountedEditor (the first import still runs) */
  mounted?: number;
  /** the first element of the model is in the DOM */
  rendered?: number;
  /** the editor's DOM came to rest after that: the first fit is applied */
  ready?: number;
}

/** window.__boardSpikeEmbed: the contract's EmbedHooks plus what the cost measurements read */
export interface EmbedPageHooks extends EmbedHooks {
  via: Via;
  timings: EmbedTimings;
}

/** what shows that an import rendered: an element's graphics, or one of dmn-js's HTML views */
const RENDERED = "[data-element-id] > .djs-visual, .dmn-decision-table-container table, .dmn-literal-expression";
/** the editor's DOM unchanged for this long after the first element: the import and its fit are through */
const SETTLE_MS = 100;
/** no element at all and the DOM unchanged for this long: a model without elements */
const EMPTY_MS = 1500;

const root = document.getElementById("root")!;
const params = readEmbedParams(location.search);
if (params) void run(params);
else {
  const note = document.createElement("p");
  note.className = "board-stub";
  note.textContent = "An embed frame of the board spike: the board page opens it with ?frame=&file=&notation=";
  root.append(note);
}

async function run({ frame, file, notation }: EmbedParams): Promise<void> {
  const lines: string[] = [];
  const connection = connectToHub({ frame });
  /** errors and sync notices: kept here and sent to the board page's log */
  const log = (line: string): void => {
    lines.push(line);
    connection.log(line);
  };
  window.addEventListener("error", (event) => log(`error: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    log(`unhandledrejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  const via = viaOf(location.search);
  const host = document.createElement("div");
  root.classList.add("board-embed");
  root.append(host);
  const page = document.documentElement;
  page.dataset.boardEmbed = notation;
  page.dataset.armed = "false";

  const timings: EmbedTimings = { timeOrigin: performance.timeOrigin };
  const mark = (name: Exclude<keyof EmbedTimings, "timeOrigin">): void => void (timings[name] = performance.now());
  const hooks: EmbedPageHooks = {
    ready: false,
    armed: false,
    notation,
    file,
    probe: createProbe({ host, text: () => connection.ytext.toString() }),
    editor: undefined,
    log: () => [...lines],
    via,
    timings,
  };
  Object.assign(window, { [EMBED_KEY]: hooks });

  let editor: MountedEditor | undefined;
  let importFailure: string | undefined;
  /** resolves once the editor shows its first import or failed to: arming waits for it */
  const settled = (async (): Promise<void> => {
    // the replica is empty until the hub's state came, and an editor bound to an empty text reports a failed import
    await connection.ready;
    mark("connected");
    const product = productMount(notation, via);
    // the stylesheets are scoped under this class: the bpmn-io theme and each renderer's own sheet
    host.className = `board-embed__host ${product.canvasClassName}`;
    const context: EditorContext = {
      ytext: connection.ytext,
      doc: connection.doc,
      repo: "spike/board",
      docPath: file,
      // a conflict notice ("your last action crossed a colleague's change")
      onSyncError: (message) => log(`sync: ${message}`),
      onImportFailed: (message) => void (importFailure = message),
      onBadgeClick: () => undefined,
      onSelectionChanged: () => undefined,
    };
    editor = await product.mount(host, context);
    hooks.editor = editor;
    mark("mounted");
    await firstImport(
      host,
      () => importFailure,
      () => mark("rendered"),
    );
    mark("ready");
  })().then(
    () => {
      hooks.ready = true;
      connection.reportReady();
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`failed: ${message}`);
      connection.reportReady(message);
    },
  );

  // Preview keeps no focus. `inert` on the frame element does not stop a focus() made in here
  // (measured), and diagram-js focuses its canvas whenever a popup menu closes.
  document.addEventListener(
    "focusin",
    (event) => {
      if (page.dataset.armed === "true") return;
      if (event.target instanceof HTMLElement || event.target instanceof SVGElement) event.target.blur();
    },
    true,
  );

  let wanted = false;
  connection.onArm(async (armed) => {
    wanted = armed;
    // the stylesheet shows or hides the editing chrome by this, at once
    page.dataset.armed = String(armed);
    await settled;
    // a later request overtook this one while the editor loaded
    if (wanted !== armed) return;
    if (armed) takeInput(editor);
    // the first answer of a frame that loads in preview has nothing to let go of
    else if (hooks.armed) release(host);
    hooks.armed = armed;
  });

  window.addEventListener("pagehide", () => {
    // the product's order: the editor (it unbinds first), then the document it was bound to
    editor?.destroy();
    connection.disconnect();
  });
}

/**
 * Resolves once the editor's first import shows and its DOM came to rest (the fit after the import
 * changes the viewport's transform), rejects with the import's error. A MountedEditor has no
 * "import done": the DOM is all this page can watch. Timers, no animation frames: a frame the
 * board does not show may not get any.
 */
function firstImport(host: HTMLElement, failed: () => string | undefined, onRendered: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let changedAt = performance.now();
    const observer = new MutationObserver(() => void (changedAt = performance.now()));
    observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
    let rendered = false;
    const tick = (): void => {
      const failure = failed();
      if (failure === undefined && !rendered && host.querySelector(RENDERED)) {
        rendered = true;
        onRendered();
      }
      const quiet = performance.now() - changedAt;
      if (failure === undefined && quiet < (rendered ? SETTLE_MS : EMPTY_MS)) {
        setTimeout(tick, 20);
        return;
      }
      observer.disconnect();
      if (failure === undefined) resolve();
      else reject(new Error(failure));
    };
    tick();
  });
}

/** armed: the keys go to this document and to the canvas in it */
function takeInput(editor: MountedEditor | undefined): void {
  window.focus();
  // a canvas takes the focus; a view without one (the DMN decision table) leaves it with the window
  editor?.focus?.();
}

/**
 * Preview: nothing stays selected, open or focused. MountedEditor has no call for that, so the
 * page does what a person does: Escape ends a running tool or drag (diagram-js listens for the
 * keyup on the document), a click on the empty canvas drops the selection, commits an open label
 * editor and closes a popup menu.
 */
function release(host: HTMLElement): void {
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }));
  for (const canvas of host.querySelectorAll(".djs-container > svg")) {
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 }));
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
  getSelection()?.removeAllRanges();
}
