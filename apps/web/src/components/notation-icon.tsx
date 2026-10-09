/**
 * Each notation's icon — one a user can GUESS from the label — shown in the
 * repo page's "New" menu, on its model rows, and in the start page's model
 * counts (#213), so a notation reads the same wherever it shows up. A
 * notation without an entry falls back to the neutral Shapes, so a new
 * registry entry never ships icon-less.
 */
import {
  Boxes,
  ChartNetwork,
  ChevronsRight,
  FileText,
  type LucideIcon,
  Shapes,
  StickyNote,
  Table2,
  Users,
  Workflow,
} from "lucide-react";

const NOTATION_ICONS = new Map<string, LucideIcon>([
  ["bpmn", Workflow],
  ["dmn", Table2],
  ["wardley", ChartNetwork],
  ["team-topology", Users],
  ["event-storming", StickyNote],
  ["context-map", Boxes],
  ["value-chain", ChevronsRight],
  ["markdown", FileText],
]);

/** the icon of a notation registry id */
export function notationIcon(notation: string): LucideIcon {
  return NOTATION_ICONS.get(notation) ?? Shapes;
}
