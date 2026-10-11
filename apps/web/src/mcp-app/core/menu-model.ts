/**
 * The document menu (spec §3) as pure data: what the widget can do right now
 * → groups of items (empty groups collapse), the header identity, and the
 * WAI-ARIA menu-button key model. chrome/menu.ts renders and wires it; the
 * item ids are the contract between the two.
 *
 * On purpose NOT here: undo/redo (keyboard, like the SPA), Rename, Duplicate,
 * History, Notes, Diagram|Source — web-app moves one click away through Open
 * in designIQ. Superseded: Open only (the instance is a viewer now).
 * DOM-free (`.ts` relative imports): node --test loads it.
 */
import { byId, modelStem } from "@designiq/notations";

import type { DecisionView } from "./engine.ts";
import type { DocLabel } from "./lifecycle.ts";

export type { WidgetKind } from "./layout.ts";
import type { DisplayMode, WidgetKind } from "./layout.ts";

/** icons.ts names the menu draws */
export type MenuIcon =
  | "external-link"
  | "save"
  | "refresh-cw"
  | "sticky-note"
  | "list-todo"
  | "shield-check"
  | "table-2"
  | "network"
  | "scan"
  | "maximize-2"
  | "minimize-2";

/** "open" | "save" | "reload" | "workshop" | "todos" | "checks" | "fit" |
 *  "fullscreen" | `view:<dmn view id>` */
export type MenuItemId =
  "open" | "save" | "reload" | "workshop" | "todos" | "checks" | "fit" | "fullscreen" | `view:${string}`;

export interface MenuItem {
  id: MenuItemId;
  label: string;
  icon: MenuIcon;
  role: "menuitem" | "menuitemcheckbox" | "menuitemradio";
  /** checkbox / radio state */
  checked?: boolean;
  disabled?: boolean;
  /** why it is disabled ("All changes saved") — also the title */
  hint?: string;
  /** trailing keyboard hint ("⌘S", "⇧1") */
  kbd?: string;
  /** the Todos count chip */
  count?: number;
  /** the Checks verdict chip text ("7/7", "1 failing") */
  verdict?: { text: string; tone: "ok" | "bad" | "muted" };
  /** activation expands this inline confirm first (CI §9 destructive confirm) */
  confirm?: { question: string; cancel: string; confirm: string };
  /** checkbox items toggle and stay open (Space/Enter) */
  keepsOpen?: boolean;
}

export interface MenuGroup {
  id: "document" | "work" | "view";
  items: MenuItem[];
}

/** a dmn view as the menu lists it (engines/dmn.ts views()) */
export type DmnView = DecisionView;

export interface MenuContext {
  kind: WidgetKind;
  /** an editable engine (not the read-only boot) */
  editable: boolean;
  /** the lifecycle's Save now availability (ChromePort.setSaveButton, merged
   *  by the adapter) — absent reads as offered */
  saveButton?: { visible: boolean; enabled: boolean };
  live: boolean;
  dirty: boolean;
  saving: boolean;
  /** a decision card owns the next step */
  paused: boolean;
  /** superseded — the menu holds Open only */
  inactive: boolean;
  /** bpmn editable: the Workshop switch */
  workshop?: { on: boolean };
  /** bpmn, once the tracker answered */
  todos?: { count: number; open: boolean };
  /** dmn, once the tests tool answered */
  checks?: { open: boolean; verdict?: MenuItem["verdict"] };
  /** dmn: the views and the active one */
  views?: { items: DmnView[]; active?: string };
  /** a diagram view is shown (not the DMN table) — Fit is offered */
  viewport: boolean;
  /** availableDisplayModes includes "fullscreen" */
  fullscreenOffered: boolean;
  displayMode: DisplayMode;
  /** linkTarget() && publicUrl */
  deepLink: boolean;
  /** ⌘ vs Ctrl in the hints */
  mac?: boolean;
}

export const DISCARD_CONFIRM = {
  question: "Discard your unsaved change?",
  cancel: "Cancel",
  confirm: "Discard and reload",
} as const;

export function buildMenu(ctx: MenuContext): MenuGroup[] {
  const document: MenuItem[] = [];
  const work: MenuItem[] = [];
  const view: MenuItem[] = [];

  if (ctx.deepLink) document.push({ id: "open", label: "Open in designIQ", icon: "external-link", role: "menuitem" });
  if (!ctx.inactive) {
    // Save now: editable autosave mode only — live sync saves every edit
    if (ctx.editable && !ctx.live && ctx.saveButton?.visible !== false) {
      const save: MenuItem = {
        id: "save",
        label: "Save now",
        icon: "save",
        role: "menuitem",
        kbd: ctx.mac === false ? "Ctrl+S" : "⌘S",
      };
      if (ctx.saving) Object.assign(save, { disabled: true, hint: "Saving…" });
      else if (ctx.saveButton?.enabled === false) Object.assign(save, { disabled: true, hint: "Not available" });
      else if (ctx.paused) Object.assign(save, { disabled: true, hint: "Decide on the open question first" });
      else if (!ctx.dirty) Object.assign(save, { disabled: true, hint: "All changes saved" });
      document.push(save);
    }
    // not live: autosave, read-only, after a failure — a live room is the latest version
    // — not while a save is in flight: its result would land after the re-read
    if (!ctx.live) {
      document.push({
        id: "reload",
        label: "Reload latest version",
        icon: "refresh-cw",
        role: "menuitem",
        ...(ctx.saving
          ? { disabled: true, hint: "Saving…" }
          : ctx.dirty && ctx.editable
            ? { confirm: DISCARD_CONFIRM }
            : {}),
      });
    }

    if (ctx.kind === "bpmn" && ctx.editable && ctx.workshop) {
      work.push({
        id: "workshop",
        label: "Workshop mode",
        icon: "sticky-note",
        role: "menuitemcheckbox",
        checked: ctx.workshop.on,
        keepsOpen: true,
      });
    }
    if (ctx.kind === "bpmn" && ctx.todos) {
      work.push({
        id: "todos",
        label: "Todos",
        icon: "list-todo",
        role: "menuitemcheckbox",
        checked: ctx.todos.open,
        count: ctx.todos.count,
      });
    }
    if (ctx.kind === "dmn" && ctx.checks) {
      work.push({
        id: "checks",
        label: "Checks",
        icon: "shield-check",
        role: "menuitemcheckbox",
        checked: ctx.checks.open,
        ...(ctx.checks.verdict ? { verdict: ctx.checks.verdict } : {}),
      });
    }
    if (ctx.kind === "dmn" && ctx.views) {
      const tables = ctx.views.items.filter((v) => v.type !== "drd");
      for (const v of ctx.views.items) {
        work.push({
          id: `view:${v.id}`,
          // one table reads as "the" table; several list by decision name
          label:
            v.type === "drd"
              ? "Decision requirements (DRD)"
              : tables.length > 1
                ? v.name || v.id
                : v.type === "decisionTable"
                  ? "Decision table"
                  : v.name || "Literal expression",
          icon: v.type === "drd" ? "network" : "table-2",
          role: "menuitemradio",
          checked: v.id === ctx.views.active,
        });
      }
    }

    if (ctx.viewport) view.push({ id: "fit", label: "Fit diagram", icon: "scan", role: "menuitem", kbd: "⇧1" });
    if (ctx.fullscreenOffered) {
      const fs = ctx.displayMode === "fullscreen";
      view.push({
        id: "fullscreen",
        label: fs ? "Exit fullscreen" : "Open fullscreen",
        icon: fs ? "minimize-2" : "maximize-2",
        role: "menuitem",
      });
    }
  }
  const groups: MenuGroup[] = [
    { id: "document", items: document },
    { id: "work", items: work },
    { id: "view", items: view },
  ];
  return groups.filter((g) => g.items.length > 0);
}

// ── identity ────────────────────────────────────────────────────────────────

/** the trigger's name: the file stem (process or decision id) — known from
 *  the tool input at load start, so no title ever reads "Loading…" */
export function docName(doc: DocLabel | undefined): string {
  if (!doc) return "";
  if (doc.id) return doc.id;
  if (doc.path) return modelStem(doc.path);
  return doc.repo;
}

export interface MenuHeader {
  /** 600 14px: the stem */
  name: string;
  /** "Order to Cash · BPMN 2.0" — or the notation label alone */
  sub: string;
  repo: string;
  /** Geist Mono 11, wraps; absent until the read resolved it */
  path?: string;
}

/** the one place the full identity shows (the trigger carries name + title) */
export function menuHeader(doc: DocLabel, notationId: string, displayName?: string): MenuHeader {
  const label = byId(notationId)?.label ?? notationId;
  const shown = displayName?.trim();
  return {
    name: docName(doc),
    sub: shown ? `${shown} · ${label}` : label,
    repo: doc.repo,
    ...(doc.path ? { path: doc.path } : {}),
  };
}

/** the trigger's accessible name and title */
export function triggerLabels(doc: DocLabel): { ariaLabel: string; title: string } {
  return {
    ariaLabel: `Menu — ${docName(doc)}`,
    title: doc.path ? `${doc.repo} · ${doc.path}` : doc.repo,
  };
}

// ── the WAI-ARIA menu-button key model ──────────────────────────────────────

/**
 * Roving focus over the flat item list (disabled items are skipped): ↑/↓
 * wrap, Home/End jump, a printable character runs first-letter type-ahead
 * from the item after `current`. Returns the new index, or `current` when the
 * key does not move focus. `current = -1` = nothing focused yet.
 */
export function menuKeyNav(
  items: ReadonlyArray<Pick<MenuItem, "label" | "disabled">>,
  current: number,
  key: string,
): number {
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  if (enabled.length === 0) return current;
  const pos = enabled.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return enabled[(pos + 1) % enabled.length]!;
    case "ArrowUp":
      return enabled[pos <= 0 ? enabled.length - 1 : pos - 1]!;
    case "Home":
      return enabled[0]!;
    case "End":
      return enabled[enabled.length - 1]!;
    default: {
      if (key.length !== 1 || !/\S/.test(key)) return current;
      const ch = key.toLowerCase();
      for (let step = 1; step <= enabled.length; step++) {
        const i = enabled[(Math.max(pos, -1) + step + enabled.length) % enabled.length]!;
        if (items[i]!.label.toLowerCase().startsWith(ch)) return i;
      }
      return current;
    }
  }
}
