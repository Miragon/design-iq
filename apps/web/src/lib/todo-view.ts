/**
 * Shared todo view-model derivations of the SPA panel (components/
 * todo-panel.tsx) and the MCP-App widget (mcp-app/todos.ts) — the two
 * frontends render differently (JSX vs imperative DOM) but must answer these
 * questions identically. Framework-free, like lib/todo-canvas.ts.
 */
import type { TodoWire } from "@designiq/contracts/live-host";

/** the todos anchored to ONE element (the canvas-badge filter) — by any of
 *  the anchor ids that land on it (TodoCanvas.anchorIds) */
export const todosForElement = (todos: TodoWire[], anchorIds: string | readonly string[]): TodoWire[] => {
  const ids = typeof anchorIds === "string" ? [anchorIds] : anchorIds;
  return todos.filter((t) => t.anchor?.elements.some((el) => ids.includes(el.id)));
};

/** display label of a filtered element: the creation-time name snapshot from
 *  any todo that carries one, else the raw id — readable after a rename */
export const elementLabel = (todos: TodoWire[], elementId: string): string =>
  todos.flatMap((t) => t.anchor?.elements ?? []).find((el) => el.id === elementId && el.name)?.name ?? elementId;

/** the empty-list line — the filtered/unfiltered wording is shared vocabulary;
 *  `noun` names the model ("process", "Wardley Map", "document", …) */
export const emptyTodoMessage = (filtered: boolean, noun = "process"): string =>
  filtered ? "No open todos on this element." : `No open todos for this ${noun}.`;

/** the Add todo titles — the anchor is the selection at submit time;
 *  `noun` names the model a todo without elements is filed on */
export function addTodoTitle(selected: number, noun = "process"): string {
  return selected > 0
    ? `Anchor a todo to the ${selected} selected element${selected === 1 ? "" : "s"}`
    : `Create a todo on the whole ${noun} (no element selected)`;
}

export const openInTrackerTitle = (id: string): string => `Open #${id} in the tracker`;
export const closeInTrackerTitle = (id: string): string => `Close #${id} in the tracker`;

/** the issue template a todo was filed with; null for a plain todo */
export const todoTypeLabel = (todo: TodoWire): string | null => todo.anchor?.type?.name ?? null;
