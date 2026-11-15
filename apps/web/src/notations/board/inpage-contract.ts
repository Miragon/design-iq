/**
 * What the board needs of a PRODUCT editor that the product's `MountedEditor` does not offer yet:
 * "the first import is on the canvas" and "let go of everything" (no selection, no open label
 * editor, no running drag, no focus inside). Until the mount contract has both, an in-page board
 * does what the embed frame does (embed-main.ts): it watches the editor's DOM and acts as a person
 * would. Kept apart from the frame's copy on purpose: the frame's measured behaviour stays as it
 * is, and this file is the list of what the contract is missing.
 */

/** what shows that an import rendered: an element's graphics, or one of dmn-js's HTML views */
const RENDERED = "[data-element-id] > .djs-visual, .dmn-decision-table-container table, .dmn-literal-expression";
/** the editor's DOM unchanged for this long after the first element: the import and its fit are through */
const SETTLE_MS = 100;
/** no element at all and the DOM unchanged for this long: a model without elements */
const EMPTY_MS = 1500;

/**
 * Resolves once the editor's first import shows and its DOM came to rest (the fit after the import
 * changes the viewport's transform), rejects with the import's error. Timers, no animation frames:
 * a board in a window that is not shown may not get any.
 */
export function firstImport(host: HTMLElement, failed: () => string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    let changedAt = performance.now();
    const observer = new MutationObserver(() => void (changedAt = performance.now()));
    observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
    let rendered = false;
    const tick = (): void => {
      const failure = failed();
      if (failure === undefined && !rendered && host.querySelector(RENDERED)) rendered = true;
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

/**
 * Preview: nothing stays selected, open or focused in the editor mounted in `host`. Escape ends a
 * running tool or drag (diagram-js listens for the keyup on the document while one runs), a click
 * on the empty canvas drops the selection, taking the focus away commits an open label editor.
 * Only what lies inside `host` is touched: the page around it is the board's.
 */
export function releaseByDom(host: HTMLElement): void {
  const doc = host.ownerDocument;
  doc.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }));
  for (const canvas of host.querySelectorAll(".djs-container > svg")) {
    canvas.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, view: doc.defaultView, button: 0 }),
    );
  }
  const active = doc.activeElement;
  if ((active instanceof HTMLElement || active instanceof SVGElement) && host.contains(active)) active.blur();
  const selection = doc.getSelection();
  if (selection?.anchorNode && host.contains(selection.anchorNode)) selection.removeAllRanges();
}
