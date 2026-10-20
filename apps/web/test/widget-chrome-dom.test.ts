/**
 * The chrome modules' focus and ARIA rules, driven through test/fake-dom.ts:
 * a keyboard user never lands on <body> — the pill's Retry, Tab out of the
 * sync popover, the Workshop chip switched OFF where only the menu keeps it,
 * the DRD | Table switch, the focus hand-back around a loading card, a toast
 * that yields its place in the lane, a decision card over a folded sheet — and
 * a decision card's consequence lines describe their buttons; a leaving toast
 * fades out of the lane's flow; a click on the zoom group hands the keys back
 * to the canvas.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DecisionChrome, SyncChrome } from "../src/mcp-app/chrome/contracts.ts";
import { mountDecision } from "../src/mcp-app/chrome/decision.ts";
import { focusReturn } from "../src/mcp-app/chrome/focus.ts";
import { mountModeChip } from "../src/mcp-app/chrome/mode-chip.ts";
import { mountLiveRegions, mountSync } from "../src/mcp-app/chrome/sync.ts";
import { mountToasts } from "../src/mcp-app/chrome/toasts.ts";
import { mountViewSwitch } from "../src/mcp-app/chrome/view-switch.ts";
import { mountZoom } from "../src/mcp-app/chrome/zoom.ts";
import type { DecisionView, DecisionViews, ViewControls } from "../src/mcp-app/core/engine.ts";
import type { SyncState } from "../src/mcp-app/core/lifecycle.ts";
import { LIVE_TITLE } from "../src/mcp-app/core/sync-view.ts";
import { asEl, type FakeElement, installFakeDom } from "./fake-dom.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function syncFixture(ctx: { dirty: boolean } = { dirty: false }) {
  const dom = installFakeDom();
  const slot = dom.el("span", { id: "sync" });
  const pop = dom.el("div", { id: "sync-popover", hidden: "" });
  const said: string[] = [];
  const actions: string[] = [];
  const chrome: SyncChrome = mountSync({
    els: { sync: asEl(slot), syncPopover: asEl(pop) },
    live: {
      polite: (t) => void said.push(t),
      assertive: (t) => void said.push(`!${t}`),
      state: (t) => void said.push(t),
    },
    context: () => ({ dirty: ctx.dirty, saving: false, editable: true, deepLink: true }),
    fullscreen: () => false,
    onAction: (id) => {
      actions.push(id);
      // what lc.save() reports synchronously: the save is under way
      if (id === "retry-now") chrome.set({ kind: "saving", mode: "autosave-unavailable" });
    },
    reopenDecision: () => false,
  });
  const pill = (): FakeElement => slot.querySelector("button.pill")!;
  return { dom, slot, pop, said, actions, chrome, pill };
}

const saved: SyncState = { kind: "saved", mode: "autosave-unavailable" };

test("sync pill: a keyboard Retry leaves the focus on the pill, never on <body>", () => {
  const { dom, slot, said, actions, chrome, pill } = syncFixture({ dirty: true });
  chrome.set(saved);
  chrome.set({ kind: "failed", mode: "autosave-unavailable", retryAt: Date.now() + 5000 });
  assert.ok(!said.includes("Not saved") && !said.includes("!Not saved"), "the danger toast speaks it, not the pill");
  const retry = slot.querySelector(".pill.act")!;
  assert.equal(retry.textContent, "Retry");
  retry.focus();
  retry.click();
  assert.deepEqual(actions, ["retry-now"]);
  assert.equal(slot.querySelector(".pill.act"), null, "the group is gone");
  assert.equal(dom.active(), pill(), "the focus moved to the pill");
  chrome.set(saved);
  assert.equal(dom.active(), pill());
  assert.match(pill().getAttribute("aria-label") ?? "", /^Saved — show sync details$/);
});

test("live regions: a keyboard Retry that lands with findings is ONE #announce write — the toast's, not the pill's too", async () => {
  const dom = installFakeDom();
  const announce = dom.el("div", { id: "announce" });
  const alert = dom.el("div", { id: "alert" });
  const lane = dom.el("div", { id: "lane" });
  const slot = dom.el("span", { id: "sync" });
  const pop = dom.el("div", { id: "sync-popover", hidden: "" });
  const live = mountLiveRegions({ announce: asEl(announce), alert: asEl(alert) });
  const toasts = mountToasts({ lane: asEl(lane), live });
  const mode = "autosave-unavailable" as const;
  const warned: SyncState = { kind: "saved", mode, findings: { errors: [], warnings: ["open discussion"] } };
  let lands: SyncState = warned;
  const pill = mountSync({
    els: { sync: asEl(slot), syncPopover: asEl(pop) },
    live,
    context: () => ({ dirty: true, saving: false, editable: true, deepLink: true }),
    fullscreen: () => false,
    onAction: () => {
      // lc.save(): saving at once; the landed save, in ONE synchronous run —
      // clearFailed, showFindings (the toast when the count rose), then syncNow
      pill.set({ kind: "saving", mode });
      queueMicrotask(() => {
        toasts.dismiss("save-failed");
        if (lands.findings) {
          toasts.show({ tone: "warning", title: "Saved with 1 warning", detail: "open discussion", key: "findings" });
        }
        pill.set(lands);
      });
    },
    reopenDecision: () => false,
  });
  const beat = (): Promise<void> => new Promise((r) => setTimeout(r, 90));
  const fail = async (): Promise<void> => {
    pill.set({ kind: "failed", mode, retryAt: Date.now() + 5000 });
    toasts.show({
      tone: "danger",
      title: "Autosave failed",
      detail: "upstream unavailable. Your edits stay on this canvas — trying again in 5 s.",
      action: { label: "Retry now", run: () => {} },
      key: "save-failed",
    });
    await beat();
  };
  pill.set({ kind: "saved", mode });
  await beat();
  assert.equal(announce.textContent, "Saved");
  await fail();
  assert.match(alert.textContent, /^Autosave failed\. upstream unavailable/);

  const retry = slot.querySelector(".pill.act")!;
  retry.focus();
  retry.click();
  await beat();
  assert.equal(announce.textContent, "Saved with 1 warning. open discussion", "not '… Saved · 1 warning' on top");
  assert.equal(slot.querySelector("button.pill")!.getAttribute("aria-label"), "Saved · 1 warning — show sync details");

  // the way back without findings: no toast, the pill speaks
  lands = { kind: "saved", mode };
  await fail();
  slot.querySelector(".pill.act")!.click();
  await beat();
  assert.equal(announce.textContent, "Saved");
  toasts.dismiss("save-failed");
  toasts.dismiss("findings");
});

test("sync pill: Live carries the SPA's title; the other states none (findings ride their list)", () => {
  const { chrome, pill } = syncFixture();
  chrome.set({ kind: "live", mode: "live" });
  assert.equal(pill().title, LIVE_TITLE);
  chrome.set({ kind: "connecting", mode: "autosave-unavailable" });
  assert.equal(pill().getAttribute("title"), null);
});

test("sync popover: Tab off its last stop closes it and moves on from the pill; Shift+Tab lands on the pill", () => {
  const { dom, pop, chrome, pill } = syncFixture({ dirty: false });
  chrome.set(saved);
  pill().focus();
  pill().click();
  assert.equal(pop.hidden, false);
  assert.equal(dom.active().tagName, "H3", "the heading has the focus");
  // Save now is disabled (clean): the heading is the only stop — Tab leaves
  const tab = dom.key("Tab");
  assert.equal(pop.hidden, true);
  assert.equal(dom.active(), pill(), "the browser's Tab then moves on FROM the pill (to the zoom group)");
  assert.equal(tab.defaultPrevented, false);

  pill().click();
  const back = dom.key("Tab", { shiftKey: true });
  assert.equal(pop.hidden, true);
  assert.equal(dom.active(), pill());
  assert.equal(back.defaultPrevented, true, "Shift+Tab stops on the pill itself");

  // inner stops stay reachable: a finding row comes before the way out
  chrome.set({ ...saved, findings: { errors: [], warnings: ["open discussion"] } });
  pill().click();
  dom.key("Tab");
  assert.equal(pop.hidden, false, "Tab from the heading goes on to the finding row");
  pop.querySelector(".finding")!.focus();
  dom.key("Tab");
  assert.equal(pop.hidden, true);
  assert.equal(dom.active(), pill());
});

test("decision card: each choice is described by its consequence line; a choice without one points at nothing", () => {
  const dom = installFakeDom();
  const lane = dom.el("div", { id: "lane" });
  const cards = mountDecision({
    lane: asEl(lane),
    live: { polite: () => {}, assertive: () => {}, state: () => {} },
    fallbackFocus: () => null,
  });
  const choices = [
    { label: "Load their version", primary: true, consequence: "Your last change is discarded." },
    { label: "Overwrite anyway", danger: true, consequence: "Their change is replaced right away." },
    { label: "Keep editing", consequence: "Your next autosave replaces their change." },
  ];
  cards.show(
    "Someone saved this model in the meantime.",
    choices.map((c) => ({ ...c, run: () => {} })),
    { detail: "Autosave is paused until you choose.", tone: "warning", deferAs: "paused" },
  );
  const buttons = lane.querySelectorAll(".choices button");
  assert.deepEqual(
    buttons.map((b) => [b.textContent, lane.querySelector(`#${b.getAttribute("aria-describedby")}`)?.textContent]),
    choices.map((c) => [c.label, c.consequence]),
  );
  cards.show("This model is open in a newer widget", [{ label: "Open in designIQ", run: () => {} }], {
    detail: "This copy is read-only now.",
    tone: "info",
    deferAs: "inactive",
  });
  const open = lane.querySelector(".choices button")!;
  assert.equal(open.getAttribute("aria-describedby"), null);
});

test("lane: two toasts, one beside a decision card — a persistent toast waits OUT of the DOM and comes back in arrival order", async () => {
  const dom = installFakeDom();
  const lane = dom.el("div", { id: "lane" });
  const pill = dom.el("button", { id: "pill" });
  const live = { polite: () => {}, assertive: () => {}, state: () => {} };
  const toasts = mountToasts({ lane: asEl(lane), live, fallbackFocus: () => asEl(pill) });
  const cards = mountDecision({
    lane: asEl(lane),
    live,
    fallbackFocus: () => asEl(pill),
    onChange: () => toasts.fit(),
  });
  /** what the lane holds, top to bottom (fading ones aside) */
  const held = (): string[] =>
    lane.children
      .filter((c): c is FakeElement => typeof c !== "string" && !c.classList.contains("leaving"))
      .map((c) => (c.classList.contains("decide") ? "card" : c.querySelector("b")!.textContent));
  const button = (label: string): FakeElement | undefined =>
    lane.querySelectorAll("button").find((b) => b.textContent === label);
  const refused = (id: number): void =>
    toasts.show({
      tone: "danger",
      title: `#${id} refused`,
      action: { label: `Open #${id}`, run: () => {} },
      key: `implement-${id}`,
    });
  refused(38);
  refused(41);
  refused(42);
  assert.deepEqual(held(), ["#41 refused", "#42 refused"], "two show, the oldest waits");
  assert.equal(button("Open #38"), undefined, "a waiting toast leaves nothing to Tab to");

  // a decision card arrives (the chat composer has the focus: the card takes none):
  // one toast beside it, and the one that held the focus hands it to the pill
  button("Open #41")!.focus();
  dom.setFocused(false);
  cards.show(
    "Someone saved this model in the meantime.",
    [{ label: "Load their version", primary: true, run: () => {} }],
    {
      tone: "warning",
      deferAs: "paused",
    },
  );
  assert.deepEqual(held(), ["card", "#42 refused"]);
  assert.equal(dom.active(), pill);
  // "Decide later": the card collapses into the pill, the waiting toast comes back
  lane.querySelector(".later")!.click();
  assert.deepEqual(held(), ["#41 refused", "#42 refused"]);
  // × on #42: once it has faded, #38 comes back — above #41, in arrival order
  toasts.dismiss("implement-42");
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(held(), ["#38 refused", "#41 refused"]);
  // an auto-dismissing toast is the newest: it shows, the oldest persistent one waits …
  toasts.show({ tone: "info", title: "Loaded the server version", key: "loaded" });
  assert.deepEqual(held(), ["#41 refused", "Loaded the server version"]);
  // … and yields first when the next one comes
  toasts.show({ tone: "success", title: "Saved", key: "saved" });
  assert.deepEqual(held(), ["#41 refused", "Saved"]);
  for (const key of ["implement-38", "implement-41", "saved"]) toasts.dismiss(key);
});

test("decision card over a sheet: the sheet folds, and the focus the card took returns into its body once it unfolds", () => {
  const dom = installFakeDom();
  const lane = dom.el("div", { id: "lane" });
  const pill = dom.el("button", { id: "pill" });
  const sheet = dom.el("aside", { class: "panel" });
  const body = dom.el("div", { class: "panel-scroll" }, sheet);
  const field = dom.el("textarea", { id: "todo-body" }, body);
  // the shell's fold: the body goes (hidden — like display: none, it drops
  // the focus at once) while a card shows, and comes back when it goes
  const cards: DecisionChrome = mountDecision({
    lane: asEl(lane),
    live: { polite: () => {}, assertive: () => {}, state: () => {} },
    fallbackFocus: () => asEl(pill),
    onChange: () => {
      body.hidden = cards.isShown();
    },
  });
  const cas = (): void =>
    cards.show(
      "Someone saved this model in the meantime.",
      [
        { label: "Load their version", primary: true, run: () => {} },
        { label: "Keep editing", run: () => {} },
      ],
      { tone: "warning", deferAs: "paused" },
    );
  field.focus();
  cas();
  assert.equal(body.hidden, true, "folded under the card");
  assert.equal(dom.active().textContent, "Load their version", "the card takes the focus");
  cards.hide();
  assert.equal(body.hidden, false);
  assert.equal(dom.active(), field, "answered: back to the field that had it");
  // "Decide later": unfolded, the focus goes to the pill (§5.2)
  cas();
  lane.querySelector(".later")!.click();
  assert.equal(body.hidden, false);
  assert.equal(dom.active(), pill);
  // the pill reopens it: folded again
  cards.reopen();
  assert.equal(body.hidden, true);
  cards.hide();
});

test("lane: a leaving toast fades OUT of the flow, pinned where it was — its keyed successor never stacks on it", () => {
  const dom = installFakeDom();
  const lane = dom.el("div", { id: "lane" });
  const toasts = mountToasts({ lane: asEl(lane), live: { polite: () => {}, assertive: () => {}, state: () => {} } });
  const refused = (): void =>
    toasts.show({ tone: "danger", title: "#38 refused", action: { label: "Open #38", run: () => {} }, key: "impl" });
  refused();
  toasts.show({ tone: "info", title: "Copied" });
  const [upper, lower] = lane.children as FakeElement[];
  // laid out as in a browser: 80 over 62 in a 150px lane
  upper!.offsetHeight = 80;
  lower!.offsetTop = 88;
  lower!.offsetHeight = 62;
  lane.offsetHeight = 150;
  refused();
  assert.ok(upper!.classList.contains("leaving"));
  assert.equal(upper!.inert, true);
  assert.equal(upper!.style.bottom, "70px", "it fades where it was: 70px over the lane's bottom");
  const flowing = (lane.children as FakeElement[]).filter((c) => !c.classList.contains("leaving"));
  assert.deepEqual(
    flowing.map((c) => c.querySelector("b")!.textContent),
    ["Copied", "#38 refused"],
    "the successor takes its place in arrival order",
  );
  toasts.dismiss("impl");
});

test("Workshop chip: switched OFF where only the menu keeps it (step ≥ 3), the focus goes to the menu trigger", () => {
  const dom = installFakeDom();
  const slot = dom.el("span", { id: "mode-slot" });
  const trigger = dom.el("button", { id: "menu-trigger" });
  let on = true;
  let compact = true; // the measured degrade: step ≥ 3 hides the OFF chip (chrome CSS)
  const listeners = new Set<() => void>();
  const said: string[] = [];
  mountModeChip(
    asEl(slot),
    {
      label: "Workshop",
      title: "Workshop mode",
      isOn: () => on,
      toggle: () => {
        on = !on;
        for (const cb of listeners) cb();
      },
      onChanged: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    // the synchronous re-layout: what the stylesheet hides at this step
    () => {
      const chip = slot.querySelector("button")!;
      chip.cssHidden = compact && chip.getAttribute("aria-checked") === "false";
    },
    { fallbackFocus: () => asEl(trigger), announce: (t) => void said.push(t) },
  );
  const chip = slot.querySelector("button")!;
  chip.focus();
  chip.click();
  assert.equal(dom.active(), trigger, "the switch lives in the menu now");
  assert.deepEqual(said, ["Workshop mode off"]);

  // wide (steps 0–2): the OFF chip stays, and so does the focus
  compact = false;
  on = true;
  chip.cssHidden = false;
  for (const cb of listeners) cb();
  chip.focus();
  chip.click();
  assert.equal(dom.active(), chip);
  assert.deepEqual(said, ["Workshop mode off"], "the switch announces itself (aria-checked)");
});

test("DRD | Table switch: a keyboard press keeps the focus on the segment across the view change", async () => {
  const dom = installFakeDom();
  const slot = dom.el("span", { id: "mode-slot" });
  const list: DecisionView[] = [
    { id: "drd", name: "Credit", type: "drd" },
    { id: "credit-limit", name: "Credit limit", type: "decisionTable" },
  ];
  let active = "drd";
  const listeners = new Set<() => void>();
  const views: DecisionViews = {
    views: () => list,
    activeView: () => list.find((v) => v.id === active),
    openView: async (id) => {
      active = id;
      for (const cb of listeners) cb();
      return true;
    },
    onViewsChanged: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  let changes = 0;
  mountViewSwitch(asEl(slot), views, () => void changes++);
  const [drd, table] = slot.querySelectorAll(".seg button");
  assert.deepEqual([drd?.getAttribute("aria-pressed"), table?.getAttribute("aria-pressed")], ["true", "false"]);
  table!.focus();
  table!.click();
  await tick();
  assert.equal(dom.active(), table, "the same button — not rebuilt");
  assert.deepEqual([drd?.getAttribute("aria-pressed"), table?.getAttribute("aria-pressed")], ["false", "true"]);
  assert.ok(changes >= 2, "the menu and the layout follow every change");
  assert.equal(slot.querySelector(".seg")?.hidden, false);
  list.splice(0, 1); // a model without DMNDI is its table
  for (const cb of listeners) cb();
  assert.equal(slot.querySelector(".seg")?.hidden, true);
});

test("focus hand-back around a loading card: the trigger again after Reload, the trigger instead of a removed Try again", () => {
  const dom = installFakeDom();
  const app = dom.el("div", { id: "app" });
  const trigger = dom.el("button", { id: "menu-trigger" }, app);
  const refocus = focusReturn(asEl(app));

  // the menu's Reload left the focus on the trigger; the card hides it
  trigger.focus();
  refocus.hold();
  trigger.cssHidden = true;
  dom.body.focus(); // a hidden control blurs at the next style recalc
  trigger.cssHidden = false; // the load landed: the card is gone
  refocus.restore(() => asEl(trigger));
  assert.equal(dom.active(), trigger);

  // a failure card's Try again: replaced by the loading card — the trigger takes it
  const card = dom.el("div", { class: "state" }, app);
  const again = dom.el("button", {}, card);
  again.focus();
  refocus.hold();
  card.remove();
  assert.equal(dom.active(), dom.body);
  refocus.restore(() => asEl(trigger));
  assert.equal(dom.active(), trigger);

  // the user moved on meanwhile (or the chat composer has the focus): left alone
  const other = dom.el("button", {}, app);
  trigger.focus();
  refocus.hold();
  other.focus();
  refocus.restore(() => asEl(trigger));
  assert.equal(dom.active(), other);
  trigger.focus();
  refocus.hold();
  dom.body.focus();
  dom.setFocused(false);
  refocus.restore(() => asEl(trigger));
  assert.equal(dom.active(), dom.body, "never pulls the focus back into the widget");
});

test("zoom group: a click hands the focus back to the canvas, Enter or Space leaves it on the button", () => {
  const dom = installFakeDom();
  (globalThis as Record<string, unknown>).cancelAnimationFrame ??= () => {};
  const button = (id: string): FakeElement => dom.el("button", { id });
  const els = {
    zoom: dom.el("div", { id: "zoom" }),
    zoomOut: button("zoom-out"),
    zoomPct: button("zoom-pct"),
    zoomIn: button("zoom-in"),
    zoomFit: button("zoom-fit"),
  };
  const did: string[] = [];
  const view = {
    hasViewport: () => true,
    level: () => 1,
    zoomBy: (step: number) => void did.push(`zoomBy ${step}`),
    zoomTo: (level: number) => void did.push(`zoomTo ${level}`),
    onChange: () => () => {},
    focus: () => void did.push("focus canvas"),
  } as unknown as ViewControls;
  const zoom = mountZoom({
    els: {
      zoom: asEl(els.zoom),
      zoomOut: asEl(els.zoomOut),
      zoomPct: asEl(els.zoomPct),
      zoomIn: asEl(els.zoomIn),
      zoomFit: asEl(els.zoomFit),
    },
    fit: () => void did.push("fit"),
  });
  zoom.bind(view);
  const press = (el: FakeElement, detail: number): void =>
    (el.onclick as unknown as (e: { detail: number }) => void)({ detail });

  press(els.zoomIn, 1);
  press(els.zoomOut, 1);
  press(els.zoomPct, 2);
  press(els.zoomFit, 1);
  assert.deepEqual(did, [
    "zoomBy 0.2",
    "focus canvas",
    "zoomBy -0.2",
    "focus canvas",
    "zoomTo 1",
    "focus canvas",
    "fit",
    "focus canvas",
  ]);

  did.length = 0;
  for (const el of [els.zoomIn, els.zoomOut, els.zoomPct, els.zoomFit]) press(el, 0);
  assert.deepEqual(
    did,
    ["zoomBy 0.2", "zoomBy -0.2", "zoomTo 1", "fit"],
    "a keyboard press keeps the focus where it is",
  );
});
