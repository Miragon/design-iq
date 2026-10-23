/**
 * The widget engine of every Miragon renderer — the widget twin of the SPA's
 * Miragon editor: the spec's contract factory (`create`, or `createViewer`
 * on a read-only mount) behind the widget-core engine contract. The
 * @miragon/modeler-api laws are what the core needs: importText is silent
 * (engine invariant 1), exportText is the canonical text the SPA's live
 * binding writes too (one byte lineage), onContentChanged is the user's edit
 * and nothing else, and a viewer imports without a command stack and never
 * reports a change. The chrome's insets reach every renderer as its free
 * area (notations/miragon/spec.ts contractOptions), so keyboard creation
 * lands clear of the chrome and a pan constraint keeps the chrome's fit; the
 * chrome fits the view itself (miragonView: diagramView on the wrapped
 * diagram, to the renderer's content bounds), so the renderer does not fit
 * on import first. A renderer's own menu entries and the document's title
 * reach the widget menu as `menu` and `displayName`.
 *
 * The factories come from the loaded spec (the node --test suite hands in
 * fakes); this module imports neither a renderer nor a stylesheet.
 */
import { assertContract, bindMiragon, EMPTY_DOCUMENT, isBlank } from "@designiq/live-client/miragon-sync";
import type * as Y from "yjs";

import { attachPresenceCanvas } from "../../lib/presence-canvas.ts";
import type {
  LoadedMiragonRenderer,
  MiragonMenuHost,
  MiragonModeler,
  MiragonRendererSpec,
} from "../../notations/miragon/spec.ts";
import type { EngineOptions, Insets, LiveBindHooks, MenuHost, WidgetEngine } from "../core/engine.ts";
import { type DiagramView, diagramView } from "./diagram-js.ts";

export interface MiragonEngine extends WidgetEngine {
  /** the mounted contract instance — for tests and future extras */
  modeler: MiragonModeler;
  /** fit / zoom; `palette` is the renderer's own (top-centre, tier 1/2) */
  view: DiagramView;
}

/** the dialogs live in the mount's own host, so they go with it; the
 *  trigger is read when a dialog closes, never copied */
function menuHostIn(host: MenuHost, root: HTMLElement, readOnly: boolean): MiragonMenuHost {
  return {
    get trigger() {
      return host.trigger;
    },
    fileStem: () => host.fileStem(),
    download: (build) => host.download(build),
    root,
    readOnly,
  };
}

/**
 * The view controls of a mounted renderer, in both hosts. A fit frames the
 * renderer's own content box (`contentBounds()`, contract 1.3): the elements
 * alone leave out what a notation draws beside them (Wardley's plot and
 * axes, an arrow annotation, a team name wider than its shape), and
 * Wardley's pan constraint pulls a fit to any other box back. The method is
 * optional, so a renderer without it, or with nothing to fit, keeps
 * diagram-js's box around the elements.
 */
export function miragonView(modeler: MiragonModeler, insets?: () => Insets): DiagramView {
  return diagramView(modeler.diagram, {
    ...(insets ? { insets } : {}),
    contentBounds: () => modeler.contentBounds?.(),
  });
}

export function mountMiragonEngine(
  spec: Pick<MiragonRendererSpec, "contractNotation">,
  renderer: LoadedMiragonRenderer,
  container: HTMLElement,
  readonly: boolean,
  opts?: EngineOptions,
): MiragonEngine {
  const mount = opts ? { insets: opts.insets } : {};
  const modeler = readonly ? renderer.createViewer(mount) : renderer.create(mount);
  try {
    assertContract(modeler, spec.contractNotation);
  } catch (error) {
    modeler.destroy();
    throw error;
  }
  modeler.attachTo(container);
  const view = miragonView(modeler, opts?.insets);
  const menu =
    opts?.menuHost && renderer.menu
      ? renderer.menu(modeler, menuHostIn(opts.menuHost, container, readonly))
      : undefined;
  return {
    modeler,
    editable: !readonly,
    view,
    ...(menu ? { menu: menu.groups } : {}),
    displayName(): string | undefined {
      try {
        return renderer.title?.(modeler);
      } catch {
        return undefined; // no document imported yet: nothing to name
      }
    },
    async importText(content: string): Promise<void> {
      // refused like the SPA's live binding refuses it: the widget shows its
      // import card instead of an empty canvas
      if (isBlank(content)) throw new Error(EMPTY_DOCUMENT);
      await modeler.importText(content);
      view.importFit();
    },
    async exportText(): Promise<string> {
      if (readonly) throw new Error("read-only view");
      return modeler.exportText();
    },
    onDirty: (cb: () => void): (() => void) => modeler.onContentChanged(cb),
    selectedElementId(): string | undefined {
      const selected = modeler.elements.selection();
      return selected.length === 1 ? selected[0] : undefined;
    },
    bindLive(ytext: Y.Text, doc: Y.Doc, hooks: LiveBindHooks): () => void {
      const unbind = bindMiragon(modeler, spec.contractNotation, ytext, doc, hooks.onConflict, hooks.onImportError, {
        ...hooks.sync,
        canvasHost: container,
      });
      // the SPA's presence controller, on the diagram the renderer wraps
      // (notations/miragon/editor.ts does the same)
      const presence = hooks.presence
        ? attachPresenceCanvas(modeler.diagram, hooks.presence, modeler.elements)
        : undefined;
      return () => {
        presence?.destroy();
        unbind();
      };
    },
    destroy(): void {
      menu?.destroy();
      view.destroy();
      modeler.destroy();
    },
  };
}
