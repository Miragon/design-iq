/**
 * The widget engine of every Miragon renderer — the widget twin of the SPA's
 * Miragon editor: the spec's contract factory (`create`, or `createViewer`
 * on a read-only mount) behind the widget-core engine contract. The
 * @miragon/modeler-api laws are what the core needs: importText is silent
 * (engine invariant 1), exportText is the canonical text the SPA's live
 * binding writes too (one byte lineage), onContentChanged is the user's edit
 * and nothing else, and a viewer imports without a command stack and never
 * reports a change. The chrome's insets reach the renderer as its free area,
 * so keyboard creation lands clear of the chrome; the chrome still fits the
 * view itself (diagramView, on the wrapped diagram).
 *
 * The factories come from the loaded spec (the node --test suite hands in
 * fakes); this module imports neither a renderer nor a stylesheet.
 */
import { assertContract, bindMiragon } from "@designiq/live-client/miragon-sync";
import type * as Y from "yjs";

import { attachPresenceCanvas } from "../../lib/presence-canvas.ts";
import type { LoadedMiragonRenderer, MiragonModeler, MiragonRendererSpec } from "../../notations/miragon/spec.ts";
import type { EngineOptions, LiveBindHooks, WidgetEngine } from "../core/engine.ts";
import { type DiagramView, diagramView } from "./diagram-js.ts";

export interface MiragonEngine extends WidgetEngine {
  /** the mounted contract instance — for tests and future extras */
  modeler: MiragonModeler;
  /** fit / zoom; `palette` is the renderer's own (top-centre, tier 1/2) */
  view: DiagramView;
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
  const view = diagramView(modeler.diagram, opts ? { insets: opts.insets } : {});
  return {
    modeler,
    editable: !readonly,
    view,
    async importText(content: string): Promise<void> {
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
      const unbind = bindMiragon(modeler, spec.contractNotation, ytext, doc, hooks.onConflict, hooks.onImportError);
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
      view.destroy();
      modeler.destroy();
    },
  };
}
