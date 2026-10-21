/**
 * The widget menu (src/mcp-app/chrome/menu.ts) with a Miragon renderer's
 * own entries, under jsdom: the header names the document's title, a radio
 * group sits under its heading in a named group, a checkbox keeps its
 * check's room while unchecked, an entry without an icon keeps the icon
 * column, a dialog entry says so, and activating an entry reaches the
 * shell — a toggle with the menu open, a dialog after the menu closed and
 * gave the focus to the trigger.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { MenuContext, MenuItemId, ModelerMenu } from "../src/mcp-app/core/menu-model.ts";
import { closeDom, host } from "./renderer-dom.ts";

after(closeDom);

test("a renderer's entries in the open menu: headings, groups, checks, icons and what activating them does", async () => {
  const { mountMenu } = await import("../src/mcp-app/chrome/menu.ts");
  const { runModelerItem } = await import("../src/mcp-app/core/menu-model.ts");
  const root = host();
  const trigger = document.createElement("button");
  const name = document.createElement("span");
  const menu = document.createElement("div");
  menu.hidden = true;
  root.append(trigger, name, menu);

  let level = "design";
  let captions = false;
  const opened: string[] = [];
  const modeler: ModelerMenu = {
    model: [
      {
        kind: "radio",
        id: "level",
        label: "Level",
        options: [
          { value: "big-picture", label: "Big picture" },
          { value: "design", label: "Software design" },
        ],
        value: () => level,
        onSelect: (value) => void (level = value),
      },
      {
        kind: "checkbox",
        id: "type-captions",
        label: "Type captions",
        checked: () => captions,
        onToggle: (c) => void (captions = c),
      },
    ],
    export: [
      {
        kind: "action",
        id: "export-svg",
        label: "Export as SVG",
        icon: "file-code-corner",
        onSelect: () => opened.push("svg"),
      },
    ],
    help: [
      {
        kind: "dialog",
        id: "keyboard-shortcuts",
        label: "Keyboard shortcuts…",
        icon: "keyboard",
        onSelect: () => opened.push("shortcuts"),
      },
    ],
  };
  const context: MenuContext = {
    kind: "miragon",
    editable: true,
    live: true,
    dirty: false,
    saving: false,
    paused: false,
    inactive: false,
    viewport: false,
    fullscreenOffered: false,
    displayMode: "inline",
    deepLink: false,
    modeler,
  };
  const selected: MenuItemId[] = [];
  const chrome = mountMenu({
    els: { trigger, docName: name, menu },
    notation: "event-storming",
    context: () => context,
    displayName: () => "Checkout",
    onSelect: (id) => {
      selected.push(id);
      runModelerItem(modeler, id);
    },
  });
  chrome.setDocument({ repo: "Miragon/design-iq", path: "processes/checkout.storm" });
  trigger.click();
  assert.equal(chrome.isOpen(), true);
  assert.match(
    menu.querySelector(".menu-head")!.textContent!,
    /Checkout · Event Storming/,
    "the document's title names it",
  );

  const group = menu.querySelector<HTMLElement>('.mi-group[role="group"]')!;
  assert.equal(group.getAttribute("aria-label"), "Level");
  assert.deepEqual(
    [group.querySelector(".mi-heading")?.textContent, group.querySelector(".mi-heading")?.getAttribute("aria-hidden")],
    ["Level", "true"],
    "a heading the group's name already speaks",
  );
  assert.deepEqual(
    [...group.querySelectorAll<HTMLElement>(".mi")].map((b) => [
      b.getAttribute("role"),
      b.textContent,
      b.getAttribute("aria-checked"),
    ]),
    [
      ["menuitemradio", "Big picture", "false"],
      ["menuitemradio", "Software design", "true"],
    ],
  );
  const captionsItem = menu.querySelector<HTMLElement>('[data-key="modeler:type-captions"]')!;
  assert.equal(captionsItem.parentElement, menu, "the checkbox after the group, not in it");
  assert.ok(captionsItem.querySelector(".icon-gap"), "no icon: the column stays");
  assert.ok(captionsItem.querySelector(".icon.tick.off"), "unchecked: the check keeps its room, hidden");
  assert.equal(menu.querySelector('[data-key="modeler:keyboard-shortcuts"]')!.getAttribute("aria-haspopup"), "dialog");
  assert.ok(menu.querySelector('[data-key="modeler:export-svg"] svg.icon'), "the guide's icon");

  // a radio option and the checkbox toggle and keep the menu open, re-read
  menu.querySelector<HTMLButtonElement>('[data-key="modeler:level:big-picture"]')!.click();
  assert.equal(level, "big-picture");
  assert.equal(chrome.isOpen(), true);
  assert.equal(menu.querySelector('[data-key="modeler:level:big-picture"]')!.getAttribute("aria-checked"), "true");
  menu.querySelector<HTMLButtonElement>('[data-key="modeler:type-captions"]')!.click();
  assert.equal(captions, true);
  assert.ok(menu.querySelector('[data-key="modeler:type-captions"] .icon.tick:not(.off)'));

  // a dialog entry: the menu closes and the trigger holds the focus first
  menu.querySelector<HTMLButtonElement>('[data-key="modeler:keyboard-shortcuts"]')!.click();
  assert.equal(chrome.isOpen(), false);
  assert.equal(document.activeElement, trigger);
  assert.deepEqual(opened, ["shortcuts"]);
  assert.deepEqual(selected, ["modeler:level:big-picture", "modeler:type-captions", "modeler:keyboard-shortcuts"]);
});
