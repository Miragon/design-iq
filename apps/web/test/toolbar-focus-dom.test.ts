/**
 * The SPA toolbar's focus wiring (src/components/editor-toolbar.tsx),
 * rendered with React and radix under jsdom (test/component-dom.ts). The ⋯
 * menu is not modal (guide §5.4). After a toggle that keeps it open, a click
 * on the canvas closes it and acts there: the page under it stays live (no
 * aria-hidden, pointer events on) and the trigger does not take the focus
 * back. A modal menu swallowed that click and gave the trigger the focus, so
 * the canvas keys waited for a second click (#298). A click on a Model action
 * that opens no dialog hands the canvas the focus as the menu closes, also
 * after a press on the trigger dragged onto it, and Enter leaves the focus to
 * the trigger. The view switch tells a click from Enter or Space, and a click
 * on a document mode (BPMN's Workshop switch) hands the canvas the focus,
 * where Enter keeps it on the switch. The rules: test/canvas-focus.test.ts;
 * the real canvases: test/canvas-focus-dom.test.ts.
 */
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { closeDom } from "./component-dom.ts";

after(closeDom);

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import("@tanstack/react-router");
const { EditorToolbar } = await import("../src/components/editor-toolbar.tsx");

type ToolbarProps = Parameters<typeof EditorToolbar>[0];

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const pointer = (target: Element, type: "pointerdown" | "pointerup"): void =>
  void target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", pointerId: 1 }),
  );
/** a click with a pointer has a detail; Enter and Space click with none */
const click = (target: Element, detail: number): void =>
  void target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail }));

const menu = (): Element | null => document.querySelector('[role="menu"]');
const entry = (label: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (item) => item.textContent === label,
  );
  assert.ok(found, label);
  return found;
};

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await settle();
});

/** the toolbar beside a canvas, as the live editor lays them out */
async function mount(props: Partial<ToolbarProps> = {}) {
  const toolbar = document.createElement("div");
  const canvas = document.createElement("div");
  canvas.tabIndex = 0;
  document.body.append(toolbar, canvas);
  const calls: string[] = [];
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const root = createRoot(toolbar);
  root.render(
    createElement(RouterContextProvider, {
      // the toolbar's links need a router; the app's registered one brings the whole route tree
      router: router as never,
      children: createElement(EditorToolbar, {
        repo: "miragon/models",
        title: "Checkout",
        status: "live",
        presence: [],
        modeActions: [],
        panels: [],
        menuPanels: [],
        activePanel: null,
        onTogglePanel: () => {},
        onRelease: () => {},
        modelerMenu: {
          model: [
            {
              kind: "checkbox",
              id: "type-captions",
              label: "Type captions",
              checked: () => calls.includes("type captions"),
              onToggle: () => calls.push("type captions"),
            },
            { kind: "action", id: "tidy", label: "Tidy up", onSelect: () => calls.push("tidy") },
          ],
          export: [],
          help: [],
        },
        canvas: {
          shown: () => true,
          focus: () => {
            canvas.focus();
            return document.activeElement === canvas;
          },
        },
        ...props,
      }),
    }),
  );
  await settle();
  const trigger = toolbar.querySelector<HTMLElement>('button[aria-label="More"]');
  assert.ok(trigger, "the ⋯ trigger");
  /** where the focus is, by name: an element in a failed assertion takes the reporter minutes to print */
  const focused = (): string =>
    document.activeElement === canvas
      ? "canvas"
      : document.activeElement === trigger
        ? "trigger"
        : (document.activeElement?.tagName.toLowerCase() ?? "nothing");
  const open = async (): Promise<void> => {
    pointer(trigger, "pointerdown");
    await settle();
    assert.ok(menu(), "the menu opens");
  };
  cleanups.push(() => {
    root.unmount();
    toolbar.remove();
    canvas.remove();
  });
  return { toolbar, canvas, calls, open, focused };
}

test("⋯ menu: after a toggle keeps it open, a click on the canvas closes it and leaves the canvas the focus", async () => {
  const { canvas, calls, open, focused } = await mount();
  await open();
  pointer(entry("Type captions"), "pointerdown");
  pointer(entry("Type captions"), "pointerup");
  click(entry("Type captions"), 1);
  await settle();
  assert.deepEqual(calls, ["type captions"]);
  assert.ok(menu(), "a checkbox keeps the menu open (§5.4)");
  assert.equal(canvas.closest('[aria-hidden="true"]') === null, true, "the canvas under the open menu is not hidden");
  assert.notEqual(document.body.style.pointerEvents, "none", "the canvas under the open menu takes the click");

  pointer(canvas, "pointerdown");
  canvas.focus(); // what the browser does with a press on a focusable element
  await settle();
  assert.equal(menu() === null, true, "the click outside closes the menu");
  assert.equal(focused(), "canvas", "the trigger does not take the focus back");
});

test("⋯ menu: Escape gives the trigger the focus", async () => {
  const { open, focused } = await mount();
  await open();
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  assert.equal(menu() === null, true, "the menu closes");
  assert.equal(focused(), "trigger");
});

test("⋯ menu: a click on a Model action hands the canvas the focus as the menu closes", async () => {
  const { calls, open, focused } = await mount();
  await open();
  const tidy = entry("Tidy up");
  pointer(tidy, "pointerdown");
  pointer(tidy, "pointerup");
  click(tidy, 1);
  await settle();
  assert.deepEqual(calls, ["tidy"]);
  assert.equal(menu() === null, true, "the menu closes");
  assert.equal(focused(), "canvas");
});

test("⋯ menu: a press on the trigger dragged onto a Model action and released there hands the canvas the focus", async () => {
  const { calls, open, focused } = await mount();
  await open();
  pointer(entry("Tidy up"), "pointerup"); // radix clicks the entry itself, with no detail
  await settle();
  assert.deepEqual(calls, ["tidy"]);
  assert.equal(menu() === null, true, "the menu closes");
  assert.equal(focused(), "canvas");
});

test("⋯ menu: Enter on a Model action leaves the focus to the trigger (§5.4)", async () => {
  const { calls, open, focused } = await mount();
  await open();
  const tidy = entry("Tidy up");
  tidy.focus();
  tidy.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(calls, ["tidy"]);
  assert.equal(menu() === null, true, "the menu closes");
  assert.equal(focused(), "trigger");
});

test("view switch: a click on the canvas side says it was a pointer, Enter and Space say they were not", async () => {
  const chosen: Array<[string, boolean]> = [];
  const { toolbar } = await mount({
    view: { sourceLabel: "XML", shown: "source", onChange: (view, viaPointer) => chosen.push([view, viaPointer]) },
  });
  const diagram = toolbar.querySelector<HTMLElement>('button[aria-label="Diagram"]');
  assert.ok(diagram);
  click(diagram, 1);
  click(diagram, 0);
  assert.deepEqual(chosen, [
    ["canvas", true],
    ["canvas", false],
  ]);
});

test("a document mode (the Workshop switch): a click switches it and hands the canvas the focus, Enter keeps the focus on the switch", async () => {
  let workshop = false;
  const listeners = new Set<() => void>();
  const { toolbar, focused } = await mount({
    modeActions: [
      {
        id: "tbpm",
        label: "Workshop",
        buttonTitle: "Workshop mode (t.BPM)",
        isActive: () => workshop,
        onChanged: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        run: () => {
          workshop = !workshop;
          for (const cb of listeners) cb();
        },
      },
    ],
  });
  const toggle = toolbar.querySelector<HTMLElement>('button[role="switch"]');
  assert.ok(toggle, "the switch");
  toggle.focus();
  click(toggle, 1);
  await settle();
  assert.equal(workshop, true);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(focused(), "canvas", "the click hands the canvas the focus (guide §5.8)");

  toggle.focus();
  click(toggle, 0);
  await settle();
  assert.equal(workshop, false);
  assert.equal(focused(), "button", "Enter or Space keep the focus on the switch");
});
