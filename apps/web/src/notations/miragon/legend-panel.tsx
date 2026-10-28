/**
 * The Legend side panel of a Miragon notation that has one (context map,
 * team topology): the renderer's legend rows (LoadedMiragonRenderer.legend)
 * in the editor's side-panel shell, where the widget shows them in its own
 * panel too. The renderer module is the editor engine's, already loaded when
 * the panel opens.
 */
import { BookOpen } from "lucide-react";
import { useEffect, useRef } from "react";

import { SidePanel } from "@/components/side-panel";

import type { NotationPanelProps } from "../registry";
import type { MiragonRendererSpec } from "./spec";

export function MiragonLegendPanel({ spec, onClose }: NotationPanelProps & { spec: MiragonRendererSpec }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = body.current;
    let cancelled = false;
    let untip: (() => void) | undefined;
    void spec.load().then((renderer) => {
      if (!cancelled && node) untip = renderer.legend?.(node);
    });
    return () => {
      cancelled = true;
      untip?.();
      node?.replaceChildren();
    };
  }, [spec]);
  return (
    <SidePanel icon={BookOpen} title="Legend" onClose={onClose}>
      {/* focusable: the keyboard scrolls a legend taller than the panel */}
      <div
        ref={body}
        className="miragon-legend min-h-0 flex-1 overflow-y-auto"
        tabIndex={0}
        role="region"
        aria-label="Legend"
      />
    </SidePanel>
  );
}
