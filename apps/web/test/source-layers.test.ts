/**
 * Monaco's layers against the editor's side panels (#288). Monaco stacks its
 * scrollbar (z 11) and its find widget (z 35) over the panels (z-10), so the
 * live editor lays the source's Monaco out beside an open panel
 * (lib/side-panel-room, its own test in test/side-panel-room.test.ts) in
 * place of Monaco's automaticLayout, and src/index.css isolates its frame,
 * the overflow guard, for whatever of it still lies under a panel. The host
 * makes no stacking context: Monaco keeps its popups (suggestions, hovers,
 * the context menu) outside that frame, and they stay over a panel they reach
 * into and, in the split view, over the canvas beside the source. The
 * headless Chromium check test/source-layers-chromium.ts shows all of it in
 * the built app; this one holds the sources and the pinned Monaco's frame to
 * it. Behind the source view the canvas layer is inert and invisible but
 * keeps its pointer-events (HIDDEN_LAYER_CLASS), which a Miragon dialog open
 * in it inherits, and the sheet gives such a dialog the pointer itself as
 * well (test/canvas-focus-chromium.ts clicks one there).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import postcss, { type Rule } from "postcss";

import { HIDDEN_LAYER_CLASS } from "../src/lib/editor-view.ts";
import { MIRAGON_RENDERERS } from "../src/notations/miragon/index.ts";

const require = createRequire(import.meta.url);
const INDEX_CSS = fileURLToPath(new URL("../src/index.css", import.meta.url));
const LIVE_EDITOR = fileURLToPath(new URL("../src/components/live-editor.tsx", import.meta.url));

function indexRules(): Rule[] {
  const rules: Rule[] = [];
  postcss.parse(readFileSync(INDEX_CSS, "utf8"), { from: INDEX_CSS }).walkRules((rule) => void rules.push(rule));
  return rules;
}

/** every selector src/index.css isolates, in sheet order */
function isolatedSelectors(): string[] {
  return indexRules()
    .filter((rule) =>
      rule.some((node) => node.type === "decl" && node.prop === "isolation" && node.value === "isolate"),
    )
    .flatMap((rule) => rule.selectors);
}

/** the properties that make an element a stacking context of its own */
const STACKING =
  /^(isolation|z-index|opacity|transform|translate|scale|rotate|filter|backdrop-filter|perspective|clip-path|mask|mask-image|mix-blend-mode|contain|will-change|container-type)$/;
/** the Tailwind utilities that set one of them */
const STACKING_UTILITY =
  /^(isolate|-?z-.+|opacity-.+|transform.*|-?translate-.+|scale-.+|-?rotate-.+|blur.*|filter|backdrop-.+|mix-blend-.+|contain-.+|will-change-.+|@container.*)$/;

test("Monaco's frame in the source pane is isolated: its scrollbar and find widget stay under a side panel wherever they still reach under one", () => {
  assert.ok(isolatedSelectors().includes(".monaco-host .overflow-guard"), isolatedSelectors().join(", "));
});

test("the source pane itself makes no stacking context, in index.css or in its classes: Monaco's popups stay over a side panel and over the canvas beside the source", () => {
  const onHost = indexRules().filter((rule) =>
    rule.selectors.some((selector) => /\.monaco-host(?![\w-])[^\s>+~]*$/.test(selector.trim())),
  );
  assert.ok(onHost.length > 0, "index.css sizes the host");
  for (const rule of onHost) {
    rule.walkDecls((decl) => {
      assert.ok(!STACKING.test(decl.prop), `${rule.selector} sets ${decl.prop}`);
    });
  }
  // the classes the source pane keeps while it shows; hidden, it is transparent and inert
  const shown = /className=\{cn\("(monaco-host[^"]*)"/.exec(readFileSync(LIVE_EDITOR, "utf8"))?.[1];
  assert.ok(shown, "live-editor.tsx renders the source pane with the monaco-host class");
  for (const utility of shown.split(/\s+/)) {
    assert.ok(!STACKING_UTILITY.test(utility.split(":").at(-1) ?? utility), `the source pane carries ${utility}`);
  }
});

test("the live editor lays the source's Monaco out beside the side panels, not with Monaco's automaticLayout", () => {
  const source = readFileSync(LIVE_EDITOR, "utf8");
  const create = /sourceEditor = monaco\.editor\.create\(sourceRef\.current, \{([\s\S]*?)\n {8}\}\);/.exec(source);
  assert.ok(create, "live-editor.tsx creates the source's Monaco in the source pane");
  assert.doesNotMatch(create[1]!, /automaticLayout/, "Monaco's own layout would size it under the panel again");
  assert.match(source, /layoutBesideSidePanels\(\s*sourceEditor,\s*sourceRef\.current,/);
});

test("the pinned Monaco still names its frame overflow-guard and draws its scrollbars inside it", () => {
  const view = readFileSync(require.resolve("monaco-editor/esm/vs/editor/browser/view.js"), "utf8");
  assert.match(view, /_overflowGuardContainer\.setClassName\('overflow-guard'\)/);
  assert.match(view, /_overflowGuardContainer\.appendChild\(this\._scrollbar\.getDomNode\(\)\)/);
  assert.match(view, /this\.domNode\.appendChild\(this\._contentWidgets\.overflowingContentWidgetsDomNode\)/);
});

test("a Miragon dialog takes the pointer in its canvas host, which behind the source view keeps its pointer-events", () => {
  const taking = indexRules()
    .filter((rule) =>
      rule.some((node) => node.type === "decl" && node.prop === "pointer-events" && node.value === "auto"),
    )
    .flatMap((rule) => rule.selectors);
  for (const { canvasClassName } of MIRAGON_RENDERERS) {
    assert.ok(taking.includes(`.${canvasClassName} > dialog[open]`), `${canvasClassName}: ${taking.join(", ")}`);
  }
  assert.match(
    readFileSync(LIVE_EDITOR, "utf8"),
    /plugin\?\.canvasClassName, "absolute inset-0", !canvasShown && HIDDEN_LAYER_CLASS\)/,
    "the hidden canvas layer, whose pointer-events its dialogs inherit",
  );
  for (const utility of HIDDEN_LAYER_CLASS.split(/\s+/)) {
    assert.doesNotMatch(utility, /pointer-events/, "a hidden layer keeps its pointer-events");
  }
});
