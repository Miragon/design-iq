/**
 * The keyboard and screen reader side of the Value Chain palette in a host
 * without the modeler shell, next to its look (lib/value-chain-palette.css).
 * value-chain-renderer 0.8.1 draws an entry as `div role="button"` with an
 * `aria-label` and nothing else outside the shell's chrome: no tab stop, no
 * toolbar around the entries, no pressed tool, and nothing that turns Enter
 * or Space into the click an element is created from, so a keyboard alone
 * reached no entry. This adds what the shell's palette skin adds (guide
 * §5.5): `role="toolbar"` with the label Tools, one tab stop that roves with
 * ← → Home End, Enter and Space as a click without a pointer (the renderer
 * places a created element in its free area then), `aria-pressed` on the
 * tools, the palette ahead of the canvas in the tab order (§5.14), and the
 * canvas as the focus after a click on the island's padding (§5.8). The tooltip with the shortcut stays with the renderer: the entry's
 * name is its `aria-label`. A release that lays the palette out itself retires
 * this with the sheet (vendor-css.test.ts).
 */
import type { MiragonDiagram } from "../notations/miragon/spec.ts";

const PALETTE = ".djs-palette";
const ENTRIES = ".djs-palette-entries";
const ENTRY = ".entry";
const TOOLS_GROUP = "tools";
const TOOL_ACTION_SUFFIX = "-tool";
const TOOLBAR_LABEL = "Tools";

const actionOf = (entry: Element): string | undefined => entry.getAttribute("data-action") ?? undefined;

/** a click without a pointer: `detail` 0 tells a creating entry to use the free area, not the pointer */
function activate(entry: HTMLElement): void {
  const box = entry.getBoundingClientRect();
  entry.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );
}

// diagram-js appends the palette after the canvas's <svg>, and a Tab would reach the canvas first
function moveBeforeCanvas(palette: HTMLElement | null): void {
  const parent = palette?.parentElement;
  const svg = parent && Array.from(parent.children).find((child) => child.localName === "svg");
  if (palette && parent && svg && palette.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_PRECEDING) {
    parent.insertBefore(palette, svg);
  }
}

/** Returns what takes the listeners off again. */
export function enhanceValueChainPalette(host: HTMLElement, diagram: MiragonDiagram): () => void {
  let activeTool: string | null = null;
  let stopAction: string | undefined;
  let focusedEntry: HTMLElement | undefined;

  const entries = (): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>(`${PALETTE} ${ENTRIES} ${ENTRY}`));

  const entryOf = (target: EventTarget | null): HTMLElement | undefined => {
    if (!(target instanceof Element)) return undefined;
    const entry = target.closest<HTMLElement>(ENTRY);
    return entry && host.contains(entry) && entry.closest(PALETTE) ? entry : undefined;
  };

  // diagram-js clears and rebuilds every entry on a change, so all of it is applied again after each
  function apply(): void {
    const toolbar = host.querySelector<HTMLElement>(`${PALETTE} ${ENTRIES}`);
    if (!toolbar) return;
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", TOOLBAR_LABEL);
    moveBeforeCanvas(toolbar.closest<HTMLElement>(PALETTE));
    const all = entries();
    for (const entry of all) {
      const action = actionOf(entry);
      const isTool =
        action?.endsWith(TOOL_ACTION_SUFFIX) === true &&
        entry.closest(".group")?.getAttribute("data-group") === TOOLS_GROUP;
      if (isTool)
        entry.setAttribute("aria-pressed", String(action.slice(0, -TOOL_ACTION_SUFFIX.length) === activeTool));
    }
    const stop = all.find((entry) => actionOf(entry) === stopAction) ?? all[0];
    for (const entry of all) entry.tabIndex = entry === stop ? 0 : -1;
    restoreFocus(all);
  }

  // a rebuild removes the focused entry, and the focus would fall to the page
  function restoreFocus(all: HTMLElement[]): void {
    const lost = focusedEntry;
    if (!lost || lost.isConnected) return;
    focusedEntry = undefined;
    const active = host.ownerDocument.activeElement;
    if (active && active !== host.ownerDocument.body) return;
    all.find((entry) => actionOf(entry) === actionOf(lost))?.focus();
  }

  const onToolChanged = (event?: unknown): void => {
    const tool = (event as { tool?: string | null } | undefined)?.tool;
    activeTool = tool ?? null;
    apply();
  };

  const onFocusIn = (event: FocusEvent): void => {
    const entry = entryOf(event.target);
    if (!entry) return;
    focusedEntry = entry;
    stopAction = actionOf(entry);
    apply();
  };

  const onFocusOut = (event: FocusEvent): void => {
    const entry = entryOf(event.target);
    if (!entry || entry !== focusedEntry || !entry.isConnected) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !host.contains(next)) focusedEntry = undefined;
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const entry = entryOf(event.target);
    if (!entry) return;
    const all = entries();
    const index = all.indexOf(entry);
    const last = all.length - 1;
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowLeft":
        next = all[index <= 0 ? last : index - 1];
        break;
      case "ArrowRight":
        next = all[index >= last ? 0 : index + 1];
        break;
      case "Home":
        next = all[0];
        break;
      case "End":
        next = all[last];
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) activate(entry);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  };

  // a press on the island's padding or a separator would leave the focus on the page, where Delete and ⌘Z do nothing;
  // diagram-js stops a mousedown at the palette, so this listens on the way down
  const onMouseDown = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || !event.target.closest(PALETTE) || entryOf(event.target)) return;
    event.preventDefault();
    host.querySelector<SVGElement>(".djs-container > svg")?.focus({ preventScroll: true });
  };

  host.addEventListener("keydown", onKeydown);
  host.addEventListener("focusin", onFocusIn);
  host.addEventListener("focusout", onFocusOut);
  host.addEventListener("mousedown", onMouseDown, true);
  diagram.on("palette.changed", apply);
  diagram.on("tool-manager.update", onToolChanged);
  apply();
  return () => {
    host.removeEventListener("keydown", onKeydown);
    host.removeEventListener("focusin", onFocusIn);
    host.removeEventListener("focusout", onFocusOut);
    host.removeEventListener("mousedown", onMouseDown, true);
    diagram.off("palette.changed", apply);
    diagram.off("tool-manager.update", onToolChanged);
  };
}
