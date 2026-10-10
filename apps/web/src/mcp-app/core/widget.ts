/**
 * The one DOM composition every widget entry calls: the shared chrome
 * (shell.ts) becomes the lifecycle's ChromePort, the ext-apps App becomes its
 * ModelBridge (get_model_content / save_model_content / ui/update-model-
 * context) and its live upgrade (mint_ws_ticket + tryLive), claimDocument is
 * the newest-widget claim, and the three toolbar buttons plus the App
 * handshake are wired. A WidgetSpec is everything a notation adds: its
 * engine, its noun for the status copy, an optional deep-link builder
 * (bpmn: the process route + ?element=), the inlined fonts to rescue and
 * optional extras (bpmn: todos + the t.BPM switch; dmn: the tests panel +
 * the scenario replay).
 *
 * Data path is ontoolinput + an app-initiated get_model_content — never the
 * tool result (Claude Desktop strips structuredContent, ext-apps #696), and
 * never a payload big enough to trip the hosts' ~150k-char result limit.
 * Bundle-only (imports the App and the DOM): never loaded by a test.
 */
import { fileDeepLink } from "@designiq/contracts/deep-link";
import type { App } from "@modelcontextprotocol/ext-apps";

import { bootConfig, claimDocument, getModelContent, makeApp, mintWsTicket, saveModelContent } from "../bridge.ts";
import { loadInlinedFont, WIDGET_FONT } from "../font.ts";
import { el, mountChrome, openExternal, type WidgetChrome, wireApp } from "../shell.ts";
import type { EngineFactory, LiveEngine, WidgetEngine } from "./engine.ts";
import {
  type ChromePort,
  createWidgetLifecycle,
  type DocRef,
  type ModelBridge,
  type WidgetExtras,
} from "./lifecycle.ts";
import { tryLive } from "./live.ts";

export interface WidgetSpec<E extends WidgetEngine = WidgetEngine> {
  /** registry notation id — rides in get_model_content so an `id` resolves
   *  to THIS notation's file on a stem shared with a .bpmn */
  notation: string;
  /** chrome copy ("Loading wardley map…", the Open button title); bpmn passes
   *  "model" to keep today's strings, the others the descriptor's noun */
  noun: string;
  engine: EngineFactory<E>;
  /** the "Open in designIQ" target. Default: fileDeepLink (the SPA's /f/ splat
   *  route — every model file has it); bpmn passes the process route + ?element= */
  deepLink?: (publicUrl: string, doc: DocRef, engine: E) => string;
  /** the families beyond Geist (rescued for every widget — the chrome's
   *  typeface) whose INLINED faces must be registered past the host CSP: the
   *  notation icon font of the engines that ship one (bpmn, dmn; the Miragon
   *  renderers draw inline SVG), Geist Mono where the entry sheet carries it */
  fonts?: string[];
  /** notation-only chrome mounted after the engine, before the first import
   *  (bpmn: todos + t.BPM) — see WidgetExtras */
  extras?: (ctx: { app: App; engine: E; readonly: boolean; chrome: WidgetChrome }) => WidgetExtras;
}

const defaultDeepLink = (publicUrl: string, doc: DocRef): string => fileDeepLink(publicUrl, doc.repo, doc.path);

export function bootWidget<E extends WidgetEngine>(spec: WidgetSpec<E>): void {
  // kick off immediately — the chrome and the palette icons need them; a
  // failed rescue degrades Geist to the system sans and the icons to tofu,
  // the modeler itself is unaffected (allSettled: never a rejection)
  const fontsReady = Promise.allSettled([WIDGET_FONT, ...(spec.fonts ?? [])].map(loadInlinedFont));
  const chrome = mountChrome();
  const { toolbar, saveBtn, openBtn, fullscreenBtn, status, setStatus } = chrome;
  const cfg = bootConfig();
  const app = makeApp();
  if (cfg.publicUrl) openBtn.title = `Open this ${spec.noun} in the full designIQ web modeler (${cfg.publicUrl})`;

  const chromePort: ChromePort = {
    setTitle: (text) => {
      toolbar.title.textContent = text;
    },
    setStatus: (text, tooltip) => {
      setStatus(text);
      if (tooltip !== undefined) status.title = tooltip;
    },
    setDirty: (dirty) => {
      toolbar.dirty.hidden = !dirty;
    },
    setSaveButton: ({ visible, enabled }) => {
      if (visible !== undefined) saveBtn.hidden = !visible;
      if (enabled !== undefined) saveBtn.disabled = !enabled;
    },
    // a loaded model has a web address only when a deep-link base is known
    setOpenVisible: (visible) => {
      openBtn.hidden = !(visible && cfg.publicUrl);
    },
    showBanner: chrome.showBanner,
    hideBanner: chrome.hideBanner,
  };
  const bridge: ModelBridge = {
    // explicit keys: foreign tool args (a DMN scenario) never reach the read
    // the canvas measures its labels at import, so the import waits for the
    // fonts too — wrapped in Geist's metrics, not the fallback's (in practice
    // they are long registered: the read is a host round-trip)
    load: async (input) => {
      const [content] = await Promise.all([
        getModelContent(app, { repo: input.repo, id: input.id, path: input.path, notation: spec.notation }),
        fontsReady,
      ]);
      return content;
    },
    save: (doc, content, baseVersion) => saveModelContent(app, doc, content, baseVersion),
    saved: (doc) =>
      void app.updateModelContext({
        content: [{ type: "text", text: `User saved ${doc.repo}/${doc.path} in the modeler widget.` }],
      }),
  };
  const lc = createWidgetLifecycle<E>({
    readonly: cfg.readonly,
    noun: spec.noun,
    mountEngine: () => spec.engine(el<HTMLDivElement>("canvas"), cfg.readonly),
    bridge,
    live: (doc, engine: LiveEngine, hooks) => tryLive({ mint: () => mintWsTicket(app, doc) }, engine, hooks),
    claim: claimDocument,
    chrome: chromePort,
    extras: spec.extras && ((engine) => spec.extras!({ app, engine, readonly: cfg.readonly, chrome })),
  });

  saveBtn.onclick = () => void lc.save();
  // deep link into the web modeler. openLink FIRST, nothing awaited before it
  // — an await would burn the user activation the window.open fallback needs.
  // A still-unsaved edit follows via flushOnLeave in parallel (see lifecycle).
  openBtn.onclick = () => {
    const doc = lc.linkTarget();
    const engine = lc.engine();
    if (!doc || !engine || !cfg.publicUrl) return;
    const url = (spec.deepLink ?? defaultDeepLink)(cfg.publicUrl, doc, engine);
    void openExternal(app, url, setStatus);
    lc.flushOnLeave();
  };
  fullscreenBtn.onclick = () => void app.requestDisplayMode({ mode: "fullscreen" });

  wireApp(app, {
    setStatus,
    hasLoaded: lc.hasLoaded,
    onToolArgs: (args) => lc.load(args),
  });
}
