/**
 * The one DOM composition every widget entry calls: the frameless chrome
 * (shell.ts mountChrome) becomes the lifecycle's ChromePort, the ext-apps App
 * becomes its ModelBridge (get_model_content / save_model_content / ui/update-
 * model-context) and its live upgrade (mint_ws_ticket + tryLive),
 * claimDocument is the newest-widget claim, and the chrome's actions — Save
 * now, Reload, Open in designIQ, Try again, Ask the assistant, the teardown
 * flush — are bound to the lifecycle. A WidgetSpec is everything a notation
 * adds: its engine, its noun, an optional async preparation (Miragon: the
 * renderer module), an optional deep-link builder (bpmn: the process route +
 * ?element=), the inlined fonts to rescue and optional extras (bpmn: todos +
 * the Workshop chip; dmn: the Checks panel, the view switch, the scenario
 * replay).
 *
 * Data path is ontoolinput + an app-initiated get_model_content — never the
 * tool result (Claude Desktop strips structuredContent, ext-apps #696), and
 * never a payload big enough to trip the hosts' ~150k-char result limit.
 * Bundle-only (imports the App and the DOM): never loaded by a test.
 */
import { fileDeepLink, repoDeepLink } from "@designiq/contracts/deep-link";
import type { App } from "@modelcontextprotocol/ext-apps";

import { bootConfig, claimDocument, getModelContent, makeApp, mintWsTicket, saveModelContent } from "../bridge.ts";
import type { WidgetChrome } from "../chrome/contracts.ts";
import { loadInlinedFont, WIDGET_FONT } from "../font.ts";
import { mountChrome, openExternal, showLoadFailure, wireApp } from "../shell.ts";
import type { DecisionViews, EngineFactory, LiveEngine, WidgetEngine } from "./engine.ts";
import {
  createWidgetLifecycle,
  type DocRef,
  type ModelBridge,
  type WidgetExtras,
  type WidgetLifecycle,
} from "./lifecycle.ts";
import { tryLive } from "./live.ts";

export interface ExtrasContext<E extends WidgetEngine> {
  app: App;
  engine: E;
  readonly: boolean;
  /** toasts, the panels, the Workshop chip, the view switch, the host context */
  chrome: WidgetChrome;
}

export interface WidgetSpec<E extends WidgetEngine = WidgetEngine> {
  /** registry notation id — rides in get_model_content so an `id` resolves
   *  to THIS notation's file on a stem shared with a .bpmn */
  notation: string;
  /** chrome copy ("Loading model…", the Open button title); bpmn passes
   *  "model" to keep today's strings, the others the descriptor's noun */
  noun: string;
  /** mounted with the chrome's fit insets (EngineOptions) */
  engine: EngineFactory<E>;
  /** before the App connects (Miragon: the renderer module); a rejection
   *  shows "The <notation> modeler could not start" with Try again */
  prepare?: () => Promise<void>;
  /** the "Open in designIQ" target. Default: fileDeepLink (the SPA's /f/ splat
   *  route — every model file has it); bpmn passes the process route + ?element= */
  deepLink?: (publicUrl: string, doc: DocRef, engine: E) => string;
  /** the families beyond Geist (rescued for every widget — the chrome's
   *  typeface) whose INLINED faces must be registered past the host CSP: the
   *  notation icon font of the engines that ship one (bpmn, dmn; the Miragon
   *  renderers draw inline SVG), Geist Mono where the entry sheet carries it */
  fonts?: string[];
  /** notation-only chrome mounted after the engine, before the first import
   *  (bpmn: todos + Workshop) — see WidgetExtras */
  extras?: (ctx: ExtrasContext<E>) => WidgetExtras;
}

const hasViews = <E extends WidgetEngine>(engine: E): engine is E & DecisionViews =>
  typeof (engine as Partial<DecisionViews>).views === "function";

const defaultDeepLink = (publicUrl: string, doc: DocRef): string => fileDeepLink(publicUrl, doc.repo, doc.path);

export function bootWidget<E extends WidgetEngine>(spec: WidgetSpec<E>): void {
  // kick off immediately — the chrome and the palette icons need them; a
  // failed rescue degrades Geist to the system sans and the icons to tofu,
  // the modeler itself is unaffected (allSettled: never a rejection)
  const fontsReady = Promise.allSettled([WIDGET_FONT, ...(spec.fonts ?? [])].map(loadInlinedFont));
  const cfg = bootConfig();
  const app = makeApp();
  // assigned right after the chrome it needs — the chrome's actions read it
  // lazily (the layout asks for the state while it mounts, before it exists)
  let lc: WidgetLifecycle<E> | undefined = undefined;
  let rendererFailed = false;
  /** the decision view on screen (dmn) — the superseded freeze re-imports
   *  into a fresh viewer, which opens on the DRD, and the extras that open
   *  the table are gone by then: the composition puts the user's view back */
  let lastView: string | undefined;

  /** the deep link: the document the widget shows (its own builder), else —
   *  a load that failed before or at the read — the file or the repo route */
  const linkFor = (): string | undefined => {
    if (!cfg.publicUrl || !lc) return undefined;
    const doc = lc.linkTarget();
    const engine = lc.engine();
    if (doc && engine) return (spec.deepLink ?? defaultDeepLink)(cfg.publicUrl, doc, engine);
    const input = lc.lastInput();
    if (!input) return undefined;
    return input.path ? fileDeepLink(cfg.publicUrl, input.repo, input.path) : repoDeepLink(cfg.publicUrl, input.repo);
  };

  const chrome: WidgetChrome = mountChrome({
    app,
    notation: spec.notation,
    noun: spec.noun,
    readonly: cfg.readonly,
    ...(cfg.publicUrl ? { publicUrl: cfg.publicUrl } : {}),
    actions: {
      save: () => void lc?.save(),
      reload: () => void lc?.reload().catch((err: unknown) => showLoadFailure(chrome, err)),
      flushNow: () => lc?.flushNow() ?? Promise.resolve(),
      // openLink FIRST, nothing awaited before it — an await would burn the
      // user activation the window.open fallback needs. A still-unsaved edit
      // follows via flushOnLeave in parallel (see lifecycle).
      openInDesignIQ: () => {
        const url = linkFor();
        if (!url) return;
        void openExternal(app, url, () =>
          chrome.toast({ tone: "danger", title: "Your client blocked the link", detail: url }),
        );
        lc?.flushOnLeave();
      },
      deepLink: () => linkFor() !== undefined,
      retry: () => {
        if (rendererFailed) return start();
        const input = lc?.lastInput();
        if (input) void lc?.load(input).catch((err: unknown) => showLoadFailure(chrome, err));
      },
      askAssistant: (error) => {
        const doc = lc?.linkTarget();
        const input = lc?.lastInput();
        const where = doc
          ? `${doc.path} in ${doc.repo}`
          : `${input?.path ?? input?.id ?? "the model"} in ${input?.repo ?? "this repository"}`;
        const text = `The ${spec.noun} ${where} could not be displayed in the modeler widget. The parser reported: ${error}\nPlease fix the file so it opens again.`;
        app.sendMessage({ role: "user", content: [{ type: "text", text }] }).then(
          (result) => {
            if (result.isError) {
              chrome.toast({
                tone: "danger",
                title: "Your client refused the prompt",
                detail: "Open the model in designIQ and fix it there.",
              });
            }
          },
          (err: unknown) =>
            chrome.toast({ tone: "danger", title: "Could not ask the assistant", detail: (err as Error).message }),
        );
      },
      state: () => {
        const s = lc?.state();
        return {
          dirty: s?.dirty ?? false,
          live: s?.live ?? false,
          saving: s?.saving ?? false,
          paused: s?.paused ?? false,
          inactive: s?.inactive ?? false,
          editable: lc?.engine()?.editable ?? false,
        };
      },
      displayName: () => lc?.engine()?.displayName?.(),
    },
  });

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
  lc = createWidgetLifecycle<E>({
    readonly: cfg.readonly,
    noun: spec.noun,
    // the editor (or the boot-flag viewer) first; a viewer for the superseded freeze
    mountEngine: (readonly) => spec.engine(chrome.els.canvas, readonly, { insets: () => chrome.fitInsets() }),
    bridge,
    live: (doc, engine: LiveEngine, hooks) => tryLive({ mint: () => mintWsTicket(app, doc) }, engine, hooks),
    claim: claimDocument,
    chrome,
    extras: spec.extras && ((engine) => spec.extras!({ app, engine, readonly: cfg.readonly, chrome })),
    // both mounts (the superseded freeze re-mounts a viewer): the zoom group,
    // Tools and the layout follow engine.view, the DRD | Table switch an
    // engine with views (dmn)
    onMount: (engine, frozen) => {
      chrome.setZoom(engine.view);
      if (hasViews(engine)) {
        chrome.setViewSwitch(engine);
        let restore = frozen ? lastView : undefined;
        engine.onViewsChanged(() => {
          // the frozen import's views are up: once, back to the user's view
          if (restore && engine.views().some((v) => v.id === restore)) {
            const id = restore;
            restore = undefined;
            void engine.openView(id);
          } else if (!restore) lastView = engine.activeView()?.id;
        });
      }
      chrome.refresh();
    },
  });

  // the renderer (when the spec needs one) before the handshake: a failure is
  // a state card with Try again, never a widget that connects without a canvas
  let wired = false;
  function start(): void {
    const ready = spec.prepare?.() ?? Promise.resolve();
    ready.then(
      () => {
        if (rendererFailed) chrome.showState(undefined);
        rendererFailed = false;
        if (wired) return;
        wired = true;
        wireApp(app, {
          chrome,
          hasLoaded: () => lc?.hasLoaded() ?? false,
          onToolArgs: (args) => lc?.load(args) ?? Promise.resolve(),
        });
      },
      (err: unknown) => {
        rendererFailed = true;
        chrome.showState({ kind: "renderer-failed", error: err instanceof Error ? err.message : String(err) });
      },
    );
  }
  start();
}
