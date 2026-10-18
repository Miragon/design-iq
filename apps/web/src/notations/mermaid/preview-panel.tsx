/**
 * The Mermaid notation's Preview panel: the diagram beside the Monaco text,
 * redrawn from the debounced live text the shell feeds every open panel. It
 * turns the Text view into the editor: type on the left, see the result on
 * the right. The drawing is the viewer's (./viewer.ts), so the panel and the
 * canvas share one drawing path; React only hosts it. Wider than the list
 * panels, a diagram needs the room.
 */
import "../markdown/markdown.css";

import { Eye } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { SidePanel } from "@/components/side-panel";
import type { NotationPanelProps } from "@/notations/registry";

import { type MermaidDiagramView, mountMermaidDiagram } from "./viewer";

export function MermaidPreviewPanel({ content, onClose }: NotationPanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<MermaidDiagramView | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const mounted = mountMermaidDiagram(host.current, { label: "Diagram preview", onError: (m) => toast.error(m) });
    view.current = mounted;
    return () => {
      mounted.destroy();
      view.current = null;
    };
  }, []);
  // declared after the mount: on the first commit the view exists by now
  useEffect(() => {
    view.current?.show(content);
  }, [content]);

  return (
    <SidePanel icon={Eye} title="Preview" className="w-[min(40rem,50%)]" onClose={onClose}>
      <div ref={host} className="min-h-0 flex-1" />
    </SidePanel>
  );
}
