/**
 * Why the live editor holds no keys from its canvas: every Miragon renderer
 * at its pin acts only on a key aimed at its own canvas (contract 1.4's keys
 * recommendation), so a key typed anywhere else reaches none of them, also
 * while the canvas stays mounted behind the source view or a dialog. Under
 * jsdom (test/renderer-dom.ts), each renderer mounted by the SPA's editor:
 *
 * - With an element selected and an edit to undo, undo, delete, the arrows,
 *   select all and the single-key tools change nothing from the page itself
 *   (Safari leaves the focus there after a click on a button), a toolbar
 *   button (Chromium focuses it), the Monaco source (its EditContext) and a
 *   dialog's field; on the focused canvas they act.
 * - The zoom keys of the SPA's editor (lib/chrome-keys.ts) zoom the canvas
 *   from anywhere on the page while it is on screen and under a popover,
 *   and are the browser's while the source view hides it
 *   (EditorContext.visibility) and under a modal dialog.
 *
 * The browser run with the live editor around them, in Chromium and WebKit:
 * test/canvas-focus-chromium.ts.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import * as Y from "yjs";

import type { MiragonModeler } from "../src/notations/miragon/spec.ts";
import type { EditorContext, MountedEditor } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const DOCUMENTS: Record<string, string> = {
  wardley: "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Hot Water [0.82, 0.45]\n",
  "event-storming": "title Checkout\ncommand Place Order [240, 300]\nevent Order Placed [620, 300]\n",
  "context-map": JSON.stringify({
    version: 1,
    title: "Conference",
    contexts: [
      { id: "ctx_cfp", label: "CfP", position: { x: 40, y: 40 }, size: { width: 200, height: 110 } },
      { id: "ctx_agenda", label: "Agenda", position: { x: 500, y: 40 }, size: { width: 200, height: 110 } },
    ],
    relationships: [],
  }),
  "team-topology": JSON.stringify({
    version: 3,
    title: "Online Shop",
    nodes: [
      {
        id: "team_checkout",
        type: "stream-aligned",
        label: "Checkout",
        position: { x: 40, y: 40 },
        size: { width: 240, height: 96 },
      },
      {
        id: "team_payments",
        type: "stream-aligned",
        label: "Payments",
        position: { x: 500, y: 40 },
        size: { width: 240, height: 96 },
      },
    ],
    interactions: [],
    flows: [],
  }),
};

interface Shape {
  id: string;
  x: number;
  y: number;
  parent?: unknown;
  labelTarget?: unknown;
  waypoints?: unknown;
}
interface DiagramServices {
  get(name: "elementRegistry"): { filter(fn: (element: Shape) => boolean): Shape[] };
  get(name: "selection"): { select(element: Shape): void; get(): Shape[] };
  get(name: "canvas"): { viewbox(): { scale: number } };
}

/** the SPA's editor of `id` on its real renderer, its canvas on screen while `shown` says so */
async function mount(id: string) {
  const { MIRAGON_RENDERERS } = await import("../src/notations/miragon/index.ts");
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
  assert.ok(spec, id);
  const renderer = await spec.load();
  const container = host(spec.canvasClassName);
  const doc = new Y.Doc();
  doc.getText("content").insert(0, DOCUMENTS[id]!);
  let modeler: MiragonModeler | undefined;
  const layer = { shown: true };
  const editor: MountedEditor = mountMiragonEditor(
    spec,
    { ...renderer, create: (options) => (modeler = renderer.create(options)) },
    container,
    {
      ytext: doc.getText("content"),
      doc,
      docPath: `processes/${id}.model`,
      onSyncError: assert.fail,
      onImportFailed: assert.fail,
      onBadgeClick: () => {},
      onSelectionChanged: () => {},
      visibility: { visible: () => layer.shown, onChange: () => () => {} },
    } as unknown as EditorContext,
  );
  await wait(50);
  assert.ok(modeler, id);
  const diagram = modeler.diagram as unknown as DiagramServices;
  const svg = container.querySelector<SVGSVGElement>(".djs-container > svg");
  assert.ok(svg, `${id}: the canvas`);
  return { editor, container, diagram, svg, layer };
}

/** the page around the canvas: a toolbar button, the Monaco source, a dialog's field */
function chrome() {
  const button = document.createElement("button");
  const source = document.createElement("div");
  source.className = "monaco-editor";
  const editContext = document.createElement("div");
  editContext.className = "native-edit-context";
  editContext.tabIndex = 0;
  source.append(editContext);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const field = document.createElement("input");
  dialog.append(field);
  document.body.append(button, source, dialog);
  return {
    button,
    editContext,
    dialog,
    field,
    remove: () => [button, source, dialog].forEach((element) => element.remove()),
  };
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** undo, delete, the arrows, select all and the single-key tools of the four renderers */
const CANVAS_KEYS: Array<[key: string, init?: KeyboardEventInit]> = [
  ["z", { ctrlKey: true, code: "KeyZ" }],
  ["z", { metaKey: true, code: "KeyZ" }],
  ["Delete"],
  ["Backspace"],
  ["ArrowRight"],
  ["ArrowLeft", { shiftKey: true }],
  ["a", { ctrlKey: true, code: "KeyA" }],
  ["c", { code: "KeyC" }],
  ["e", { code: "KeyE" }],
  ["l", { code: "KeyL" }],
  ["a", { code: "KeyA" }],
  ["u", { code: "KeyU" }],
];

for (const id of Object.keys(DOCUMENTS)) {
  test(`${id}: no key reaches the canvas from the page, a toolbar button, the source or a dialog; on the focused canvas they act`, async () => {
    const { editor, container, diagram, svg } = await mount(id);
    const shapes = (): Shape[] =>
      diagram
        .get("elementRegistry")
        .filter((element) => element.parent !== undefined && !element.labelTarget && !element.waypoints);
    /** what a key that reached the canvas changes: its shapes, where they are, the selection */
    const state = (): string =>
      JSON.stringify({
        shapes: shapes()
          .map((shape) => `${shape.id}@${shape.x},${shape.y}`)
          .sort(),
        selected: diagram
          .get("selection")
          .get()
          .map((element) => element.id)
          .sort(),
      });

    // an edit to undo, made on the focused canvas, and a selection to delete
    const [first, second] = shapes();
    assert.ok(first && second, `${id}: two shapes`);
    svg.focus();
    diagram.get("selection").select(first);
    press(svg, "Delete");
    assert.equal(shapes().length, 1, `${id}: Delete on the focused canvas deletes`);
    diagram.get("selection").select(second);
    const before = state();

    const page = chrome();
    const targets: Array<[string, () => Element]> = [
      ["the page (Safari, after a click on a button)", () => document.body],
      ["a toolbar button", () => page.button],
      ["the Monaco source", () => page.editContext],
      ["a dialog's field", () => page.field],
    ];
    try {
      for (const [where, target] of targets) {
        const element = target();
        if (element instanceof HTMLElement && element !== document.body) element.focus();
        else (document.activeElement as HTMLElement | null)?.blur();
        for (const [key, init] of CANVAS_KEYS) press(element, key, init);
        assert.equal(state(), before, `${id}: no key from ${where} reaches the canvas`);
      }

      // Team Topology hears no key at all while a modal dialog is open
      page.dialog.remove();
      svg.focus();
      press(svg, "z", { ctrlKey: true, code: "KeyZ" });
      assert.equal(shapes().length, 2, `${id}: Ctrl+Z on the focused canvas undoes the delete`);
      diagram.get("selection").select(shapes()[0]!);
      press(svg, "Delete");
      assert.equal(shapes().length, 1, `${id}: Delete on the focused canvas deletes the selection`);
    } finally {
      editor.destroy();
      page.remove();
      container.remove();
    }
  });

  test(`${id}: the zoom keys zoom the canvas on screen, also under a popover; the source view and a modal dialog leave them to the browser`, async () => {
    const { editor, container, diagram, layer } = await mount(id);
    const scale = (): number => diagram.get("canvas").viewbox().scale;
    const zoomIn = (target: Element = document.body): boolean =>
      press(target, "=", { ctrlKey: true, code: "Equal" }).defaultPrevented;
    const start = scale();
    const popover = document.createElement("div");
    const page = chrome();
    page.dialog.remove();
    try {
      layer.shown = false;
      assert.equal(zoomIn(), false, `${id}: behind the source view the browser zooms the page`);
      assert.equal(press(document.body, "!", { shiftKey: true, code: "Digit1" }).defaultPrevented, false);
      assert.equal(scale(), start, `${id}: and the hidden canvas keeps its view`);

      layer.shown = true;
      popover.setAttribute("role", "dialog");
      document.body.append(popover);
      assert.equal(zoomIn(), true, `${id}: on screen, the canvas takes the key, under a popover too`);
      const zoomed = scale();
      assert.ok(zoomed > start, `${id}: one step in`);
      popover.remove();

      document.body.append(page.dialog);
      assert.equal(zoomIn(page.button), false, `${id}: under a modal dialog the browser zooms the page`);
      assert.equal(scale(), zoomed, `${id}: and the canvas keeps its view`);
      page.dialog.remove();
      assert.equal(zoomIn(page.button), true, `${id}: from a toolbar button once the dialog is gone`);
    } finally {
      editor.destroy();
      popover.remove();
      page.remove();
      container.remove();
    }
  });
}
