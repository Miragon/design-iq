/**
 * The document menu as data (src/mcp-app/core/menu-model.ts): which items a
 * widget offers in which state, the header identity, and the WAI-ARIA
 * menu-button key model chrome/menu.ts renders.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMenu,
  DISCARD_CONFIRM,
  docName,
  type MenuContext,
  menuHeader,
  menuKeyNav,
  triggerLabels,
} from "../src/mcp-app/core/menu-model.ts";

const base: MenuContext = {
  kind: "bpmn",
  editable: true,
  live: false,
  dirty: true,
  saving: false,
  paused: false,
  inactive: false,
  workshop: { on: true },
  todos: { count: 3, open: false },
  viewport: true,
  fullscreenOffered: true,
  displayMode: "inline",
  deepLink: true,
};

const ids = (ctx: MenuContext): string[][] => buildMenu(ctx).map((g) => g.items.map((i) => i.id));
const item = (ctx: MenuContext, id: string) =>
  buildMenu(ctx)
    .flatMap((g) => g.items)
    .find((i) => i.id === id);

test("bpmn autosave mode: Open · Save now · Reload | Workshop · Todos | Fit · Fullscreen", () => {
  assert.deepEqual(ids(base), [
    ["open", "save", "reload"],
    ["workshop", "todos"],
    ["fit", "fullscreen"],
  ]);
  assert.deepEqual(item(base, "save"), { id: "save", label: "Save now", icon: "save", role: "menuitem", kbd: "⌘S" });
  assert.equal(item({ ...base, mac: false }, "save")?.kbd, "Ctrl+S");
  const ws = item(base, "workshop")!;
  assert.deepEqual([ws.role, ws.checked, ws.keepsOpen], ["menuitemcheckbox", true, true]);
  assert.deepEqual([item(base, "todos")?.count, item(base, "todos")?.checked], [3, false]);
  assert.equal(item(base, "fit")?.kbd, "⇧1");
});

test("Save now: disabled with a hint when clean, while saving and while a decision is open", () => {
  assert.deepEqual(
    [item({ ...base, dirty: false }, "save")?.disabled, item({ ...base, dirty: false }, "save")?.hint],
    [true, "All changes saved"],
  );
  assert.equal(item({ ...base, saving: true }, "save")?.hint, "Saving…");
  assert.equal(item({ ...base, paused: true }, "save")?.disabled, true);
});

test("Reload with unsaved edits asks first — inline, destructive; clean it just reloads; never while saving", () => {
  assert.deepEqual(item(base, "reload")?.confirm, DISCARD_CONFIRM);
  assert.equal(DISCARD_CONFIRM.question, "Discard your unsaved change?");
  assert.equal(DISCARD_CONFIRM.confirm, "Discard and reload");
  assert.equal(item({ ...base, dirty: false }, "reload")?.confirm, undefined);
  // a save in flight lands after a re-read would — the reload waits it out
  const saving = item({ ...base, saving: true }, "reload")!;
  assert.deepEqual([saving.disabled, saving.hint, saving.confirm], [true, "Saving…", undefined]);
});

test("Save now follows the lifecycle's availability (setSaveButton): hidden when not visible, disabled when not enabled", () => {
  assert.equal(item({ ...base, saveButton: { visible: false, enabled: true } }, "save"), undefined);
  const off = item({ ...base, saveButton: { visible: true, enabled: false } }, "save")!;
  assert.deepEqual([off.disabled, off.hint], [true, "Not available"]);
  assert.equal(item({ ...base, saveButton: { visible: true, enabled: true } }, "save")?.disabled, undefined);
  assert.equal(
    item({ ...base, saveButton: { visible: false, enabled: true } }, "workshop")?.id,
    "workshop",
    "Workshop stays",
  );
});

test("live drops Save now and Reload (a live room is the latest version and saves every edit)", () => {
  assert.deepEqual(ids({ ...base, live: true, dirty: false }), [
    ["open"],
    ["workshop", "todos"],
    ["fit", "fullscreen"],
  ]);
});

test("read-only drops Save and Workshop — Open, Reload, the panels, Fit and Fullscreen stay", () => {
  assert.deepEqual(ids({ ...base, editable: false, dirty: false }), [
    ["open", "reload"],
    ["todos"],
    ["fit", "fullscreen"],
  ]);
});

test("superseded: Open only — everything else is removed, not disabled", () => {
  assert.deepEqual(ids({ ...base, inactive: true }), [["open"]]);
  assert.deepEqual(ids({ ...base, inactive: true, deepLink: false }), [], "no link: an empty menu");
});

test("empty groups collapse; Fullscreen only when offered, labelled by the actual mode", () => {
  const bare: MenuContext = {
    ...base,
    kind: "miragon",
    workshop: undefined,
    todos: undefined,
    fullscreenOffered: false,
    viewport: false,
    deepLink: false,
  };
  assert.deepEqual(ids(bare), [["save", "reload"]]);
  assert.equal(item({ ...base, displayMode: "fullscreen" }, "fullscreen")?.label, "Exit fullscreen");
  assert.equal(item({ ...base, displayMode: "fullscreen" }, "fullscreen")?.icon, "minimize-2");
  assert.equal(item(base, "fullscreen")?.label, "Open fullscreen");
  assert.equal(item(base, "fullscreen")?.icon, "maximize-2");
});

test("dmn: Checks with its verdict, the view radios — one table reads 'Decision table', several list by decision name", () => {
  const dmn: MenuContext = {
    ...base,
    kind: "dmn",
    workshop: undefined,
    todos: undefined,
    checks: { open: true, verdict: { text: "7/7", tone: "ok" } },
    views: {
      items: [
        { id: "drd", name: "Credit decisions", type: "drd" },
        { id: "credit-limit", name: "Credit limit check", type: "decisionTable" },
      ],
      active: "credit-limit",
    },
    viewport: false,
  };
  assert.deepEqual(ids(dmn), [["open", "save", "reload"], ["checks", "view:drd", "view:credit-limit"], ["fullscreen"]]);
  const radios = buildMenu(dmn)
    .flatMap((g) => g.items)
    .filter((i) => i.role === "menuitemradio")
    .map((i) => [i.label, i.icon, i.checked]);
  assert.deepEqual(radios, [
    ["Decision requirements (DRD)", "network", false],
    ["Decision table", "table-2", true],
  ]);
  assert.deepEqual(item(dmn, "checks")?.verdict, { text: "7/7", tone: "ok" });
  const multi = {
    ...dmn,
    views: {
      items: [
        { id: "drd", name: "", type: "drd" as const },
        { id: "a", name: "Risk class", type: "decisionTable" as const },
        { id: "b", name: "Credit limit check", type: "decisionTable" as const },
      ],
      active: "drd",
    },
    viewport: true,
  };
  assert.deepEqual(
    buildMenu(multi)
      .flatMap((g) => g.items)
      .filter((i) => i.role === "menuitemradio")
      .map((i) => i.label),
    ["Decision requirements (DRD)", "Risk class", "Credit limit check"],
  );
  assert.ok(ids(multi).flat().includes("fit"), "the DRD is a diagram: Fit is back");
  assert.equal(item({ ...dmn, kind: "bpmn" }, "checks"), undefined, "Checks is dmn-only");
});

test("identity: the stem names the trigger, the header carries display name, notation, repo and path", () => {
  assert.equal(docName({ repo: "Miragon/design-iq", id: "order-to-cash" }), "order-to-cash");
  assert.equal(docName({ repo: "Miragon/design-iq", path: "processes/team.ttm.json" }), "team");
  assert.equal(docName({ repo: "Miragon/design-iq" }), "Miragon/design-iq");
  assert.deepEqual(
    menuHeader(
      { repo: "Miragon/design-iq", path: "processes/order-to-cash.bpmn", id: "order-to-cash" },
      "bpmn",
      "Order to Cash",
    ),
    {
      name: "order-to-cash",
      sub: "Order to Cash · BPMN 2.0",
      repo: "Miragon/design-iq",
      path: "processes/order-to-cash.bpmn",
    },
  );
  assert.equal(menuHeader({ repo: "r", path: "x.storm" }, "event-storming").sub, "Event Storming");
  assert.deepEqual(triggerLabels({ repo: "Miragon/design-iq", path: "processes/order-to-cash.bpmn" }), {
    ariaLabel: "Menu — order-to-cash",
    title: "Miragon/design-iq · processes/order-to-cash.bpmn",
  });
});

test("key model: ↑/↓ wrap past disabled items, Home/End jump, first-letter type-ahead from the next item", () => {
  const items = [
    { label: "Open in designIQ" },
    { label: "Save now", disabled: true },
    { label: "Reload latest version" },
    { label: "Fit diagram" },
    { label: "Open fullscreen" },
  ];
  assert.equal(menuKeyNav(items, -1, "ArrowDown"), 0, "↓ opens on the first enabled item");
  assert.equal(menuKeyNav(items, -1, "ArrowUp"), 4, "↑ opens on the last");
  assert.equal(menuKeyNav(items, 0, "ArrowDown"), 2, "the disabled Save now is skipped");
  assert.equal(menuKeyNav(items, 4, "ArrowDown"), 0, "wraps");
  assert.equal(menuKeyNav(items, 0, "ArrowUp"), 4);
  assert.equal(menuKeyNav(items, 2, "Home"), 0);
  assert.equal(menuKeyNav(items, 2, "End"), 4);
  assert.equal(menuKeyNav(items, 0, "o"), 4, "type-ahead starts after the current item");
  assert.equal(menuKeyNav(items, 4, "O"), 0, "and wraps, case-insensitive");
  assert.equal(menuKeyNav(items, 0, "s"), 0, "a disabled match is skipped — focus stays");
  assert.equal(menuKeyNav(items, 3, "Tab"), 3, "not a navigation key");
});
