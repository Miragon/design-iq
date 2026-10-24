/**
 * Monaco's layers against the editor's side panels (#288), in src/index.css:
 * Monaco stacks its scrollbar (z 11) and its find widget (z 35) over the
 * panels (z-10), so its frame, the overflow guard, is isolated. The host is
 * not: Monaco keeps its popups (suggestions, hovers, the context menu) outside
 * that frame, and they stay over a panel they reach into and, in the split
 * view, over the canvas beside the source. The headless Chromium check
 * test/source-layers-chromium.ts shows both in the built app; this one holds
 * the stylesheet and the pinned Monaco's frame to them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import postcss from "postcss";

const require = createRequire(import.meta.url);
const INDEX_CSS = fileURLToPath(new URL("../src/index.css", import.meta.url));

/** every selector src/index.css isolates, in sheet order */
function isolatedSelectors(): string[] {
  const selectors: string[] = [];
  postcss.parse(readFileSync(INDEX_CSS, "utf8"), { from: INDEX_CSS }).walkRules((rule) => {
    if (rule.some((node) => node.type === "decl" && node.prop === "isolation" && node.value === "isolate")) {
      selectors.push(...rule.selectors);
    }
  });
  return selectors;
}

test("Monaco's frame in the source pane is isolated: its scrollbar and find widget stay under an open side panel", () => {
  assert.ok(isolatedSelectors().includes(".monaco-host .overflow-guard"), isolatedSelectors().join(", "));
});

test("the source pane itself is not isolated: Monaco's popups stay over a side panel and over the canvas beside the source", () => {
  assert.ok(!isolatedSelectors().includes(".monaco-host"));
});

test("the pinned Monaco still names its frame overflow-guard and draws its scrollbars inside it", () => {
  const view = readFileSync(require.resolve("monaco-editor/esm/vs/editor/browser/view.js"), "utf8");
  assert.match(view, /_overflowGuardContainer\.setClassName\('overflow-guard'\)/);
  assert.match(view, /_overflowGuardContainer\.appendChild\(this\._scrollbar\.getDomNode\(\)\)/);
  assert.match(view, /this\.domNode\.appendChild\(this\._contentWidgets\.overflowingContentWidgetsDomNode\)/);
});
