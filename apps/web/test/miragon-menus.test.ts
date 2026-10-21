/**
 * What designIQ adds to the Miragon renderers' chrome, for real (under
 * jsdom, test/renderer-dom.ts), through the specs both hosts mount them
 * with: the zoom keys and ⇧1 of the SPA's editors on a real canvas.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { fitViewbox } from "@miragon/modeler-shell/core";
import * as Y from "yjs";

import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";
import type { LoadedMiragonRenderer, MiragonModeler, MiragonRendererSpec } from "../src/notations/miragon/spec.ts";
import type { EditorContext, MountedEditor } from "../src/notations/registry.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function load(id: string): Promise<[MiragonRendererSpec, LoadedMiragonRenderer]> {
  const spec = MIRAGON_RENDERERS.find((s) => s.id === id);
  assert.ok(spec, id);
  return [spec, await spec.load()];
}

const MAP =
  "title Tea Shop\ncomponent Cup of Tea [0.79, 0.61]\ncomponent Hot Water [0.82, 0.45]\nCup of Tea->Hot Water\n";

/** the SPA's editor of a Wardley map on a shared Y.Text */
async function editorOf(id: string) {
  const [spec, renderer] = await load(id);
  const { mountMiragonEditor } = await import("../src/notations/miragon/editor.ts");
  const container = host(spec.canvasClassName);
  const doc = new Y.Doc();
  doc.getText("content").insert(0, MAP);
  let modeler: MiragonModeler | undefined;
  const editor: MountedEditor = mountMiragonEditor(
    spec,
    { ...renderer, create: (o) => (modeler = renderer.create(o)) },
    container,
    {
      ytext: doc.getText("content"),
      doc,
      docPath: `processes/${id}.model`,
      onSyncError: assert.fail,
      onImportFailed: assert.fail,
    } as unknown as EditorContext,
  );
  await wait(50);
  assert.ok(modeler);
  return { editor, container, modeler, renderer };
}

test("the SPA's Miragon editors: the zoom keys and ⇧1 drive the canvas, a text field keeps them", async () => {
  const { editor, container, modeler, renderer } = await editorOf("wardley");
  const { spaFitInsets } = await import("../src/notations/miragon/editor.ts");
  const canvas = modeler.diagram.get("canvas") as { viewbox(): { scale: number } };
  const scale = (): number => Math.round(canvas.viewbox().scale * 1000) / 1000;
  const press = (key: string, code: string, mods: Partial<KeyboardEventInit>, target: Element = document.body) => {
    const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
    target.dispatchEvent(event);
    return event;
  };
  assert.equal(press("0", "Digit0", { ctrlKey: true }).defaultPrevented, true, "the page does not zoom");
  assert.equal(scale(), 1, "Ctrl+0: 100 %");
  press("=", "Equal", { ctrlKey: true });
  assert.equal(scale(), Math.round(2 ** 0.2 * 1000) / 1000, "Ctrl+= one step in, as the widget's +");
  press("-", "Minus", { metaKey: true });
  assert.equal(scale(), 1, "⌘- one step out");
  const field = document.createElement("input");
  container.append(field);
  assert.equal(press("=", "Equal", { ctrlKey: true }, field).defaultPrevented, false);
  assert.equal(scale(), 1, "a text field keeps the key: the browser zooms the page");
  field.remove();
  // ⇧1: the plot with its axes into what the renderer's palette leaves free
  press("!", "Digit1", { shiftKey: true });
  const fitted = fitViewbox(renderer.contentBounds!(modeler)!, { width: 1000, height: 640 }, spaFitInsets(1000, 640));
  assert.ok(fitted);
  assert.equal(scale(), Math.round(fitted.scale * 1000) / 1000);
  assert.deepEqual(spaFitInsets(1000, 640), { top: 88, right: 24, bottom: 64, left: 24 }, "the shell's insets");
  assert.equal(spaFitInsets(720, 640).top, 140, "the palette's second row from 760px down");
  editor.destroy();
  assert.equal(press("=", "Equal", { ctrlKey: true }).defaultPrevented, false, "gone with the editor");
});
