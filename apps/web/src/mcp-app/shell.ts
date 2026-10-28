/**
 * The widget chrome's composition (spec §11): the skeleton every entry
 * carries (mcp-app*.html), the chrome modules behind chrome/contracts.ts and
 * the ChromePort the lifecycle drives — `mountChrome()` returns ONE
 * WidgetChrome. Plus what is mechanically identical across every widget:
 * openExternal (the host-open ladder) and wireApp (the App handshake tail,
 * whose failures become state cards).
 *
 * The registries the notation extras fill live here too: the Workshop chip
 * (bpmn), the DRD | Table switch (dmn), the panels (todos.ts / dmn-checks.ts;
 * their badges the menu's Todos / Checks item repeats) and the zoom group's view.
 */
import { byId } from "@designiq/notations";
import type { App } from "@modelcontextprotocol/ext-apps";

import type {
  ChromeElements,
  ChromeOptions,
  ModeChip,
  PanelBadge,
  PanelHandle,
  PanelSpec,
  StateAction,
  StateCardSpec,
  WidgetChrome,
} from "./chrome/contracts.ts";
import { mountDecision } from "./chrome/decision.ts";
import { focusReturn } from "./chrome/focus.ts";
import { mountHost } from "./chrome/host.ts";
import { chromeKeyDeps, mountKeys } from "./chrome/keys.ts";
import { mountLayout } from "./chrome/layout-dom.ts";
import { mountExternalLinks } from "./chrome/links.ts";
import { mountMenu } from "./chrome/menu.ts";
import { mountModeChip } from "./chrome/mode-chip.ts";
import { mountPanels } from "./chrome/panel.ts";
import { mountStateCards } from "./chrome/state-card.ts";
import { mountLiveRegions, mountSync } from "./chrome/sync.ts";
import { mountToasts } from "./chrome/toasts.ts";
import { mountViewSwitch } from "./chrome/view-switch.ts";
import { mountZoom } from "./chrome/zoom.ts";
import type { DecisionViews, ExportFile, ViewControls } from "./core/engine.ts";
import { stateActionPlan } from "./core/feedback.ts";
import type { ChromeKey } from "./core/keymap.ts";
import { sheetFolds, type WidgetKind } from "./core/layout.ts";
import { type DocLabel, LoadError, type ModelInput, type SyncState, type ToastSpec } from "./core/lifecycle.ts";
import { docName, type MenuContext, type MenuItemId, panelOfItem, runModelerItem } from "./core/menu-model.ts";
import type { PopoverActionId } from "./core/sync-view.ts";
import { icon, mountIcons } from "./icons.ts";

export const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** the skeleton's static elements (ids: mcp-app*.html) */
export function chromeElements(): ChromeElements {
  return {
    app: el("app"),
    canvas: el("canvas"),
    tl: el("tl"),
    trigger: el("menu-trigger"),
    docName: el("doc-name"),
    tools: el("tools"),
    modeSlot: el("mode-slot"),
    tr: el("tr"),
    fullscreen: el("fullscreen"),
    open: el("open"),
    bl: el("bl"),
    sync: el("sync"),
    br: el("br"),
    zoom: el("zoom"),
    zoomOut: el("zoom-out"),
    zoomPct: el("zoom-pct"),
    zoomIn: el("zoom-in"),
    zoomFit: el("zoom-fit"),
    lane: el("lane"),
    state: el("state"),
    menu: el("menu"),
    syncPopover: el("sync-popover"),
    announce: el("announce"),
    alert: el("alert"),
  };
}

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function mountChrome(opts: ChromeOptions): WidgetChrome {
  // the static HTML names its icons (data-icon) — the panels' too
  mountIcons();
  const els = chromeElements();
  const kind = (els.app.dataset.kind ?? "miragon") as WidgetKind;
  const { actions } = opts;
  const mac = isMac();
  let view: ViewControls | undefined;
  let doc: DocLabel | undefined;
  let landed = false; // an import landed once — later state cards float over the inert canvas
  let modeChip: ModeChip | undefined;
  let offChip: (() => void) | undefined;
  let views: DecisionViews | undefined;
  let offViews: (() => void) | undefined;
  let retired = false;

  let syncState: SyncState = { kind: "loading" };
  // the lifecycle's own word on Save now (setDirty / setSaveButton, merged
  // partial updates) — the menu item and the popover action are gated on it
  let dirty = false;
  const saveAvail = { visible: false, enabled: true };

  // ── the modules (chrome/contracts.ts) ──
  const live = mountLiveRegions(els);
  const host = mountHost(opts.app, { teardown: () => actions.flushNow() });
  const panels = mountPanels({ layout: () => layout.current(), closeTools: () => void layout.closeTools() });
  const layout = mountLayout({
    els,
    kind,
    host,
    view: () => view,
    readonly: () => opts.readonly || actions.state().inactive,
    panelOpen: () => panels.active() !== undefined,
    // never for the first layout (mounted above the toasts): a later room
    // re-plans them, a card turned sheet folds under a decision card
    onLane: () => {
      toasts.fit();
      refold();
    },
  });
  /** where the focus lands when the surface holding it goes away: the pill */
  const pill = (): HTMLElement | null => els.sync.querySelector("button");
  // the lane (spec §5.1): the toasts fit the room the layout leaves, beside the decision card
  const toasts = mountToasts({ lane: els.lane, live, fallbackFocus: pill, room: () => layout.lane().room });
  const decision = mountDecision({
    lane: els.lane,
    live,
    fallbackFocus: pill,
    onChange: () => {
      refold();
      toasts.fit();
      // the focus returns right after hide(): the sheet must already end
      // where the lane now ends, or its scroller moves for a stale height
      layout.syncLane();
    },
  });
  /** spec §7: while a decision card shows, an open sheet folds to its head;
   *  the card answered or deferred, it unfolds where it was (synchronously —
   *  the focus returns into it right after) */
  const refold = (): void => panels.fold(sheetFolds(layout.panel().mode, decision.isShown()));
  const stateCards = mountStateCards({
    els,
    notationLabel: byId(opts.notation)?.label ?? opts.notation,
    hasCanvas: () => landed,
    actions: (card) => stateActions(card),
  });
  const sync = mountSync({
    els,
    live,
    context: () => {
      const s = actions.state();
      const hs = host.state();
      return {
        dirty,
        saving: s.saving,
        editable: !opts.readonly && s.editable && !s.inactive,
        saveButton: { ...saveAvail },
        deepLink: actions.deepLink(),
        ...(hs.locale ? { locale: hs.locale } : {}),
        ...(hs.timeZone ? { timeZone: hs.timeZone } : {}),
        mac,
      };
    },
    fullscreen: () => host.state().displayMode === "fullscreen",
    // Save now and Retry now are the same explicit save (a "Saved" toast when it lands)
    onAction: (id: PopoverActionId) => (id === "open" ? actions.openInDesignIQ() : actions.save()),
    reopenDecision: () => {
      if (decision.isDeferred()) {
        decision.reopen();
        return true;
      }
      // paused: the pill stands for the card on screen — bring it to attention
      return syncState.kind === "paused" && decision.focus();
    },
  });
  const menu = mountMenu({
    els,
    notation: opts.notation,
    context: () => menuContext(),
    displayName: () => actions.displayName(),
    onSelect: (id) => onMenu(id),
  });
  const chromeKeys = chromeKeyDeps({
    menuOpen: () => menu.isOpen(),
    hasViewport: () => view?.hasViewport() ?? false,
    stateCardShown: () => stateCards.current() !== undefined,
    run(key: ChromeKey) {
      if (key === "fit") layout.refit(true);
      else if (key === "zoomToActual") view?.zoomTo(1);
      else view?.stepZoom(key === "zoomIn" ? 1 : -1);
    },
  });
  // the Miragon renderers bind no keys of their own: the chrome takes the
  // zoom keys on the whole widget document; bpmn-js and the DMN DRD hear them
  // on their focused canvas (EngineOptions.chromeKeys)
  const documentKeys = kind === "miragon";
  const zoom = mountZoom({
    els,
    fit: () => layout.refit(true),
    ...(documentKeys ? { keys: { platform: mac ? "mac" : "other" } } : {}),
  });
  mountKeys(document, {
    save: () => {
      const s = actions.state();
      // read-only, superseded or no model loaded: the browser's own ⌘S
      if (opts.readonly || !s.editable || s.inactive || stateCards.current() !== undefined) return false;
      // handled either way (no browser "Save page"): the lifecycle answers a
      // live room or a clean canvas with an info toast, and PUTs nothing
      actions.save();
      return true;
    },
    fit: () => {
      if (!view?.hasViewport()) return false;
      layout.refit(true);
      return true;
    },
    escape: [() => menu.close(true), () => sync.closePopover(), () => layout.closeTools(), () => panels.escape()],
    ...(documentKeys ? { chromeKeys } : {}),
  });
  // a renderer's dialog or popover links out (Wardley's X-axis labels…): the
  // sandbox blocks the new window, so the host opens it, never silently
  if (kind === "miragon") {
    mountExternalLinks(els.canvas, (url) => {
      void openExternal(opts.app, url, () =>
        toasts.show({ tone: "danger", title: "Your client blocked the link", detail: url }),
      );
    });
  }

  // ── the panels the extras registered: their badge and availability feed
  // the menu's Todos / Checks item (one source, the TR toggle repeats it) ──
  const registered = new Map<PanelSpec["id"], { handle: PanelHandle; available: boolean; badge?: PanelBadge }>();
  function registerPanel(spec: PanelSpec): PanelHandle {
    const handle = panels.register(spec);
    const entry: { handle: PanelHandle; available: boolean; badge?: PanelBadge } = { handle, available: false };
    registered.set(spec.id, entry);
    return {
      open: () => handle.open(),
      close: () => handle.close(),
      toggle: () => handle.toggle(),
      isOpen: () => handle.isOpen(),
      collapse: () => handle.collapse(),
      setAvailable(available) {
        entry.available = available;
        handle.setAvailable(available);
        menu.refresh();
      },
      setBadge(badge) {
        if (badge) entry.badge = badge;
        else delete entry.badge;
        handle.setBadge(badge);
        menu.refresh();
      },
    };
  }
  /** the menu's view of a panel — absent until discovery answered, and for a viewer */
  function panelState(id: PanelSpec["id"]): { open: boolean; badge?: PanelBadge } | undefined {
    const entry = registered.get(id);
    if (!entry?.available || actions.state().inactive) return undefined;
    return { open: entry.handle.isOpen(), ...(entry.badge ? { badge: entry.badge } : {}) };
  }
  panels.onChange(() => {
    layout.update();
    refold(); // a sheet opened under a decision card opens folded
    menu.refresh();
  });
  // Tools opened over a compact sheet: the palette would sit under it — the
  // sheet steps aside (its toggle reopens it where it was), just as opening
  // a panel closes Tools. Runs after layout-dom's own click handler.
  els.tools.addEventListener("click", () => {
    const open = panels.active();
    if (open && els.tools.getAttribute("aria-expanded") === "true") registered.get(open)?.handle.collapse();
  });

  function menuContext(): MenuContext {
    const s = actions.state();
    const todos = panelState("todos");
    const checks = panelState("checks");
    const legend = panelState("legend");
    const modelerMenu = actions.modelerMenu();
    const verdict = checks?.badge?.verdict;
    return {
      kind,
      editable: !opts.readonly && s.editable,
      saveButton: { ...saveAvail },
      live: s.live,
      dirty,
      saving: s.saving,
      paused: s.paused,
      inactive: s.inactive,
      ...(modeChip && s.editable ? { workshop: { on: modeChip.isOn() } } : {}),
      ...(todos ? { todos: { count: todos.badge?.count ?? 0, open: todos.open } } : {}),
      ...(checks
        ? {
            checks: {
              open: checks.open,
              // a running suite shows its spinner on the toggle; the menu waits for the verdict
              ...(verdict && !verdict.spinner ? { verdict: { text: verdict.text, tone: verdict.tone } } : {}),
            },
          }
        : {}),
      ...(views ? { views: { items: views.views(), active: views.activeView()?.id } } : {}),
      ...(modelerMenu ? { modeler: modelerMenu } : {}),
      ...(legend ? { legend: { open: legend.open } } : {}),
      viewport: view?.hasViewport() ?? false,
      fullscreenOffered: fullscreenShown(),
      displayMode: host.state().displayMode,
      deepLink: actions.deepLink(),
      mac,
    };
  }

  function onMenu(id: MenuItemId): void {
    if (id.startsWith("view:")) {
      void views?.openView(id.slice("view:".length));
      return;
    }
    const modelerMenu = actions.modelerMenu();
    if (modelerMenu && runModelerItem(modelerMenu, id)) return;
    const panel = panelOfItem(id);
    if (panel) {
      registered.get(panel)?.handle.toggle();
      return;
    }
    switch (id) {
      case "open":
        return actions.openInDesignIQ();
      case "save":
        return actions.save();
      case "reload":
        return actions.reload();
      case "workshop":
        return modeChip?.toggle();
      case "fit":
        return layout.refit(true);
      case "fullscreen":
        void toggleFullscreen();
        return;
    }
  }

  /** the §5.3 actions (core/feedback.ts picks them) bound to the lifecycle */
  function stateActions(card: StateCardSpec): StateAction[] {
    const run = {
      retry: () => actions.retry(),
      open: () => actions.openInDesignIQ(),
      ask: () => actions.askAssistant(card.error ?? ""),
    };
    return stateActionPlan(card.kind, { deepLink: actions.deepLink(), message: host.state().message }).map((a) => ({
      label: a.label,
      icon: a.icon,
      primary: a.primary,
      run: run[a.id],
    }));
  }

  // ── TR: fullscreen and Open in designIQ ──
  const fullscreenShown = (): boolean => host.fullscreenOffered() && landed && !actions.state().inactive;
  let fsIcon: "maximize-2" | "minimize-2" = "maximize-2";
  const renderFullscreen = (): void => {
    els.fullscreen.hidden = !fullscreenShown();
    const fs = host.state().displayMode === "fullscreen";
    const label = fs ? "Exit fullscreen" : "Open fullscreen";
    els.fullscreen.setAttribute("aria-label", label);
    els.fullscreen.title = label;
    const want = fs ? "minimize-2" : "maximize-2";
    if (want !== fsIcon) {
      fsIcon = want;
      els.fullscreen.querySelector("svg")?.replaceWith(icon(want));
    }
  };
  const toggleFullscreen = (): Promise<unknown> =>
    host.requestDisplayMode(host.state().displayMode === "fullscreen" ? "inline" : "fullscreen");
  els.fullscreen.onclick = () => void toggleFullscreen();
  els.open.onclick = () => actions.openInDesignIQ();
  if (opts.publicUrl) els.open.title = `Open this ${opts.noun} in the full designIQ web modeler (${opts.publicUrl})`;
  host.onChange(() => {
    renderFullscreen();
    sync.refresh();
    menu.refresh();
  });

  /** superseded: the instance is a viewer now — panels, toggles, Tools,
   *  Workshop, Save and fullscreen go; zoom and fit stay */
  function retire(): void {
    // the extras are destroyed already (they guard their late results) —
    // this closes the panels and hides their toggles for good
    for (const entry of registered.values()) {
      entry.available = false;
      entry.handle.setAvailable(false);
    }
    chrome.setModeChip(undefined);
    layout.closeTools();
    // the old editor stays mounted through the final flush: no edit may reach
    // it then (the viewer shows what was saved) — the frozen mount's setZoom
    // lifts this; a read-only viewer is not re-mounted and never needs it
    if (actions.state().editable) els.canvas.inert = true;
  }

  /** the control a loading card hides (the trigger after Reload, a failure
   *  card's Try again) gets the focus back when the load lands */
  const refocus = focusReturn(els.app);

  /** a state card owns the widget: the floating layers over the hidden work
   *  chrome close with it (their triggers are gone) */
  function showCard(card: StateCardSpec): void {
    menu.close(false);
    if (sync.isPopoverOpen()) sync.closePopover();
    stateCards.show(card);
  }

  // blank paper first; a widget still waiting after 400 ms says so
  setTimeout(() => {
    if (!doc && stateCards.current() === undefined) showCard({ kind: "booting" });
  }, 400);

  const chrome: WidgetChrome = {
    els,
    kind,
    canvasKeys: chromeKeys,
    // ── ChromePort ──
    setDocument(next) {
      doc = next;
      menu.setDocument(next);
      layout.update();
    },
    setStatus: (text, tooltip) => sync.setActivity(text, tooltip),
    setSync(next: SyncState) {
      syncState = next;
      sync.set(next);
      const card = stateCards.current();
      if (next.kind === "loading") {
        // before the card: the focused control blurs once it is hidden
        if (card !== "loading" && card !== "booting") refocus.hold();
        showCard({ kind: "loading", ...(doc ? { name: docName(doc) } : {}) });
      } else {
        landed = true;
        menu.setVisible(true);
        if (card === "loading" || card === "booting") {
          stateCards.show(undefined);
          refocus.restore(() => (els.trigger.hidden ? pill() : els.trigger));
        }
      }
      if (next.kind === "inactive" && !retired) {
        retired = true;
        retire();
      }
      renderFullscreen();
      menu.refresh();
    },
    setPeers: (peers) => sync.setPeers(peers),
    toast: (t) => toasts.show(t),
    dismissToast: (key) => toasts.dismiss(key),
    setDirty(next) {
      dirty = next;
      sync.refresh();
      menu.refresh();
    },
    setSaveButton(next) {
      if (next.visible !== undefined) saveAvail.visible = next.visible;
      if (next.enabled !== undefined) saveAvail.enabled = next.enabled;
      sync.refresh();
      menu.refresh();
    },
    setOpenVisible(visible) {
      els.open.hidden = !(visible && opts.publicUrl);
      layout.update();
      menu.refresh();
    },
    showBanner(title, choices, o = {}) {
      // the superseded card arrives without actions: Open in designIQ is the
      // one move left (secondary — the card has no primary)
      const list =
        choices.length === 0 && o.deferAs === "inactive" && actions.deepLink()
          ? [{ label: "Open in designIQ", run: () => actions.openInDesignIQ() }]
          : choices;
      decision.show(title, list, o);
    },
    hideBanner: () => decision.hide(),
    showState(card) {
      if (!card) {
        stateCards.show(undefined);
        return;
      }
      // a failed load hides the menu trigger until a load succeeds (§6.1)
      menu.setVisible(false);
      showCard({ ...card, ...(card.name || !doc ? {} : { name: docName(doc) }) });
    },
    // ── registries ──
    registerPanel,
    setModeChip(chip) {
      offChip?.();
      offChip = undefined;
      modeChip = chip;
      els.modeSlot.textContent = "";
      if (chip) {
        offChip = mountModeChip(
          els.modeSlot,
          chip,
          () => {
            menu.refresh();
            layout.update();
          },
          // the switch lives in the menu once the OFF chip leaves the row (step ≥ 3)
          { fallbackFocus: () => els.trigger, announce: live.polite, focusCanvas: () => view?.focus?.() },
        );
      }
      layout.update();
    },
    setViewSwitch(next) {
      offViews?.();
      offViews = undefined;
      views = next;
      els.modeSlot.textContent = "";
      if (next) {
        offViews = mountViewSwitch(els.modeSlot, next, () => {
          menu.refresh();
          layout.update();
        });
      }
      layout.update();
    },
    setZoom(next) {
      view = next;
      zoom.bind(next);
      // the superseded freeze mounted its viewer: navigation is back (retire)
      if (retired && stateCards.current() === undefined) els.canvas.inert = false;
      layout.update();
      menu.refresh();
    },
    fitInsets: () => layout.current().fitInsets,
    host: () => host.state(),
    requestDisplayMode: (mode) => host.requestDisplayMode(mode),
    connected: () => host.connected(),
    refresh() {
      sync.refresh();
      menu.refresh();
      layout.update();
    },
    announce: (text, assertive = false) => (assertive ? live.assertive : live.polite)(text),
  };
  return chrome;
}

/**
 * Open an external URL from inside the app sandbox: the sandbox blocks plain
 * navigation, so the HOST opens it (`ui/open-link`). A denial or a missing
 * bridge (the dev preview outside a host) falls back to window.open; if that
 * is blocked too, tell the caller instead of swallowing the click. Callers own
 * the error sink (a danger toast vs. the todo panel's error row).
 */
export async function openExternal(app: App, url: string, onBlocked: (msg: string) => void): Promise<void> {
  try {
    const { isError } = await app.openLink({ url });
    if (!isError) return;
  } catch {
    /* no host bridge — try the browser directly */
  }
  // NOT the "noopener" feature: that makes window.open return null even on
  // success, which would misreport every working fallback as blocked — sever
  // the opener on the returned proxy instead
  const win = window.open(url, "_blank");
  if (win) {
    win.opener = null;
    return;
  }
  onBlocked(`Could not open ${url} — your client blocked it.`);
}

/**
 * Hand an export to the user from inside the app sandbox, which blocks
 * downloads: the HOST saves it (`ui/download-file`), with its own
 * confirmation. A host without that capability, a refusal and a failed
 * build each get a toast: an export never fails silently (guide §9).
 */
export async function downloadExport(
  app: App,
  build: () => Promise<ExportFile>,
  toast: (spec: ToastSpec) => void,
): Promise<void> {
  if (!app.getHostCapabilities()?.downloadFile) {
    toast({
      tone: "danger",
      title: "Your client cannot save files from this widget",
      detail: "Open the model in designIQ to export it.",
    });
    return;
  }
  try {
    const file = await build();
    const uri = `file:///${encodeURIComponent(file.name)}`;
    const resource =
      typeof file.data === "string"
        ? { uri, mimeType: file.mimeType, text: file.data }
        : { uri, mimeType: file.mimeType, blob: await base64Of(file.data) };
    const { isError } = await app.downloadFile({ contents: [{ type: "resource", resource }] });
    if (isError)
      toast({ tone: "info", title: `${file.name} was not saved`, detail: "Your client declined the download." });
  } catch (err) {
    toast({ tone: "danger", title: "Export failed", detail: err instanceof Error ? err.message : String(err) });
  }
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // in slices: String.fromCharCode takes its bytes as arguments
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** a load that did not land → its state card (the stage picks it); the
 *  status copy stays the popover's activity line */
export function showLoadFailure(chrome: WidgetChrome, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  chrome.setStatus(`Load failed: ${message}`);
  chrome.showState({
    kind: err instanceof LoadError && err.stage === "import" ? "import-failed" : "read-failed",
    error: message,
  });
}

/**
 * The App handshake tail: guard the tool input (`repo` is the one required
 * argument), turn load failures into state cards, tell the user when a host
 * never delivers tool input at all (Claude iOS, ext-apps #734 — the
 * alternative is an eternal spinner), and connect.
 */
export function wireApp(
  app: App,
  opts: {
    chrome: WidgetChrome;
    /** true once a load owns the widget — suppresses the no-input card */
    hasLoaded: () => boolean;
    onToolArgs: (args: ModelInput) => Promise<void>;
  },
): void {
  const { chrome } = opts;
  app.ontoolinput = (params) => {
    const args = (params.arguments ?? {}) as Partial<ModelInput>;
    if (!args.repo) {
      chrome.setStatus("Missing tool input (repo)");
      chrome.showState({ kind: "no-repo" });
      return;
    }
    opts.onToolArgs(args as ModelInput).catch((err: unknown) => showLoadFailure(chrome, err));
  };
  setTimeout(() => {
    if (opts.hasLoaded()) return;
    chrome.setStatus("No tool input received — open this connector in claude.ai or Claude Desktop.");
    chrome.showState({ kind: "no-input" });
  }, 8000);
  app.connect().then(
    () => chrome.connected(),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      chrome.setStatus(`Bridge connect failed: ${message}`);
      chrome.showState({ kind: "bridge-failed", error: message });
    },
  );
}
