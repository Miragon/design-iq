/**
 * The document menu as data (src/mcp-app/core/menu-model.ts): which items a
 * widget offers in which state, the header identity, the WAI-ARIA
 * menu-button key model chrome/menu.ts renders, and a Miragon renderer's own
 * Model, Export and Help entries among designIQ's.
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
  type ModelerMenu,
  panelOfItem,
  runModelerItem,
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
    { label: "Fit to view" },
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

// ── a Miragon renderer's own entries (mapMenu / boardMenu / contextMapMenu / diagramMenu) ──

/** the shape of a renderer's menu content, with what each entry reports */
function rendererMenu() {
  const ran: string[] = [];
  let level = "design";
  let captions = true;
  const menu: ModelerMenu = {
    model: [
      {
        kind: "radio",
        id: "level",
        label: "Level",
        options: [
          { value: "big-picture", label: "Big picture" },
          { value: "process", label: "Process modeling" },
          { value: "design", label: "Software design" },
        ],
        value: () => level,
        onSelect: (value) => {
          ran.push(`level=${value}`);
          level = value;
        },
      },
      {
        kind: "checkbox",
        id: "type-captions",
        label: "Type captions",
        keepEnabledWhenReadOnly: true,
        checked: () => captions,
        onToggle: (checked) => {
          ran.push(`captions=${checked}`);
          captions = checked;
        },
      },
      { kind: "dialog", id: "map-size", label: "Map size…", onSelect: () => ran.push("map-size") },
    ],
    export: [
      { kind: "action", id: "export-png", label: "Export as PNG", icon: "file-image", onSelect: () => ran.push("png") },
      {
        kind: "action",
        id: "export-svg",
        label: "Export as SVG",
        icon: "file-code-corner",
        shortcut: "⌘S",
        onSelect: () => ran.push("svg"),
      },
    ],
    help: [
      {
        kind: "dialog",
        id: "keyboard-shortcuts",
        label: "Keyboard shortcuts…",
        icon: "keyboard",
        onSelect: () => ran.push("shortcuts"),
      },
    ],
  };
  return { menu, ran };
}

const miragon: MenuContext = {
  ...base,
  kind: "miragon",
  workshop: undefined,
  todos: undefined,
  live: true,
  dirty: false,
};

test("a renderer's entries join in the guide's group order: Model, Export, designIQ's view moves, Help last", () => {
  const { menu } = rendererMenu();
  const ctx: MenuContext = { ...miragon, modeler: menu, legend: { open: false } };
  assert.deepEqual(
    buildMenu(ctx).map((g) => g.id),
    ["document", "model", "export", "view", "help"],
  );
  assert.deepEqual(ids(ctx), [
    ["open"],
    [
      "modeler:level:big-picture",
      "modeler:level:process",
      "modeler:level:design",
      "modeler:type-captions",
      "modeler:map-size",
      "legend",
    ],
    ["modeler:export-png", "modeler:export-svg"],
    ["fit", "fullscreen"],
    ["modeler:keyboard-shortcuts"],
  ]);
});

test("a Miragon widget's Todos item joins once the tracker answered, before the renderer's Model group", () => {
  const { menu } = rendererMenu();
  const ctx: MenuContext = { ...miragon, modeler: menu, todos: { count: 2, open: true } };
  assert.deepEqual(
    buildMenu(ctx).map((g) => g.id),
    ["document", "work", "model", "export", "view", "help"],
  );
  assert.deepEqual([item(ctx, "todos")?.count, item(ctx, "todos")?.checked], [2, true]);
  assert.equal(item({ ...ctx, todos: undefined }, "todos"), undefined, "no tracker, no item");
});

test("each entry kind becomes its item: a named radio group, a checkbox that stays open, a dialog, an action with its icon and key", () => {
  const { menu } = rendererMenu();
  const ctx: MenuContext = { ...miragon, modeler: menu };
  assert.deepEqual(item(ctx, "modeler:level:design"), {
    id: "modeler:level:design",
    label: "Software design",
    role: "menuitemradio",
    checked: true,
    checkMark: true,
    keepsOpen: true,
    radioGroup: { id: "level", label: "Level" },
  });
  assert.equal(item(ctx, "modeler:level:process")?.checked, false);
  assert.deepEqual(item(ctx, "modeler:type-captions"), {
    id: "modeler:type-captions",
    label: "Type captions",
    role: "menuitemcheckbox",
    checked: true,
    checkMark: true,
    keepsOpen: true,
  });
  assert.deepEqual(item(ctx, "modeler:map-size"), {
    id: "modeler:map-size",
    label: "Map size…",
    role: "menuitem",
    dialog: true,
  });
  assert.deepEqual(item(ctx, "modeler:export-svg"), {
    id: "modeler:export-svg",
    label: "Export as SVG",
    icon: "file-code-corner",
    role: "menuitem",
    kbd: "⌘S",
  });
  assert.equal(item(ctx, "modeler:map-size")?.icon, undefined, "no icon: the column stays empty");
});

test("a read-only canvas disables the Model entries that write the document; Type captions, Export and Help stay", () => {
  const { menu } = rendererMenu();
  const viewer: MenuContext = { ...miragon, editable: false, modeler: menu, legend: { open: true } };
  for (const id of ["modeler:level:big-picture", "modeler:level:design", "modeler:map-size"]) {
    assert.deepEqual([item(viewer, id)?.disabled, item(viewer, id)?.hint], [true, "Read-only"], id);
  }
  for (const id of [
    "modeler:type-captions",
    "legend",
    "modeler:export-png",
    "modeler:export-svg",
    "modeler:keyboard-shortcuts",
  ]) {
    assert.equal(item(viewer, id)?.disabled, undefined, id);
  }
});

test("superseded: the renderer's entries and the Legend go with everything else but Open", () => {
  const { menu } = rendererMenu();
  assert.deepEqual(ids({ ...miragon, inactive: true, modeler: menu, legend: { open: true } }), [["open"]]);
});

test("the Legend panel: the Model group's last entry, a checkbox with its check while open, without an icon", () => {
  const legend = item({ ...miragon, legend: { open: true } }, "legend");
  assert.deepEqual(legend, {
    id: "legend",
    label: "Legend",
    role: "menuitemcheckbox",
    checked: true,
    checkMark: true,
  });
  assert.equal(item({ ...miragon, legend: { open: false } }, "legend")?.checked, false);
  assert.equal(item(miragon, "legend"), undefined, "a notation without a legend has none");
});

test("Fit: every widget names it in the modeler shell's words, as the zoom group's fit button", () => {
  for (const kind of ["miragon", "bpmn", "dmn"] as const) {
    assert.equal(item({ ...miragon, kind }, "fit")?.label, "Fit to view", kind);
    assert.equal(item({ ...miragon, kind }, "fit")?.kbd, "⇧1", kind);
  }
});

test("panelOfItem: the items that toggle a panel, and only those", () => {
  assert.deepEqual((["todos", "checks", "legend", "fit", "fullscreen", "modeler:legend"] as const).map(panelOfItem), [
    "todos",
    "checks",
    "legend",
    undefined,
    undefined,
    undefined,
  ]);
});

test("runModelerItem runs the entry behind an item, and nothing else", () => {
  const { menu, ran } = rendererMenu();
  assert.equal(runModelerItem(menu, "modeler:level:process"), true);
  assert.equal(runModelerItem(menu, "modeler:level:process"), true, "the level it has: no second edit");
  assert.equal(runModelerItem(menu, "modeler:type-captions"), true);
  assert.equal(runModelerItem(menu, "modeler:map-size"), true);
  assert.equal(runModelerItem(menu, "modeler:export-svg"), true);
  assert.equal(runModelerItem(menu, "modeler:keyboard-shortcuts"), true);
  assert.deepEqual(ran, ["level=process", "captions=false", "map-size", "svg", "shortcuts"]);
  assert.equal(runModelerItem(menu, "modeler:level:unknown"), false, "an option the group does not have");
  assert.equal(runModelerItem(menu, "modeler:gone"), false);
  assert.equal(runModelerItem(menu, "fit"), false, "designIQ's own items are the shell's");
});
