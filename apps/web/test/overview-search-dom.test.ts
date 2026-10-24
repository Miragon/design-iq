/**
 * The start page's "Find a repository…" box (src/routes/overview.tsx),
 * rendered with React under jsdom (test/component-dom.ts). Its chip shows
 * `/`, and `aria-keyshortcuts` names the keys that type it on the two main
 * layouts, US first: `/` on a US keyboard, ⇧7 on a German one (guide §5.6,
 * Miragon/modeler-suite#72). Both focus the box.
 */
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { closeDom } from "./component-dom.ts";

after(closeDom);

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RepoToolbar } = await import("../src/routes/overview.tsx");

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await settle();
});

async function mount() {
  const toolbar = document.createElement("div");
  document.body.append(toolbar);
  const root = createRoot(toolbar);
  root.render(
    createElement(RepoToolbar, {
      query: "",
      show: "all",
      sort: "updated",
      favorites: true,
      onQuery: () => {},
      onShow: () => {},
      onSort: () => {},
    }),
  );
  await settle();
  cleanups.push(() => {
    root.unmount();
    toolbar.remove();
  });
  const box = toolbar.querySelector<HTMLInputElement>('input[aria-label="Find a repository"]');
  assert.ok(box, "the search box");
  return { toolbar, box };
}

/** a key pressed on the page, outside any text field */
function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
}

test("the search box names its key with the keys of the US and the German layout", async () => {
  const { toolbar, box } = await mount();
  assert.equal(box.getAttribute("aria-keyshortcuts"), "/ Shift+7");
  assert.equal(toolbar.querySelector("kbd")?.textContent, "/", "the chip shows the character");
});

test("each of the keys it names focuses the search box", async () => {
  const { box } = await mount();
  assert.equal(press({ key: "/", code: "Slash" }), true, "US: the / key");
  assert.equal(document.activeElement === box, true, "US: the box has the focus");

  box.blur();
  assert.equal(press({ key: "/", code: "Digit7", shiftKey: true }), true, "German: ⇧7");
  assert.equal(document.activeElement === box, true, "German: the box has the focus");
});
