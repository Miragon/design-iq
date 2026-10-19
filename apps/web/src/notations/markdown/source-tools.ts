/**
 * The Markdown source's tooling, the LAZY ENTRY behind the manifest's
 * attachSource (./plugin.ts): "Insert diagram", a header menu of the starter
 * diagrams (./diagram-starters.ts) and one editor action per starter, so the
 * F1 palette reaches them too. Its own chunk; the eager bundle carries none
 * of it (ADR 0006; `pnpm arch`, rule web-markdown-engine-loads-lazily).
 *
 * An insertion is ONE executeEdits between two undo stops: one undo step,
 * synced to the peers by y-monaco like any typing. ./insert-diagram.ts
 * decides where the fence goes; then the cursor selects the label the
 * starter names to edit first, and the editor has the focus back. Until the
 * source has had the focus, Monaco shows no cursor and its position is still
 * 1:1, above the document's title: the diagram goes to the document's end.
 * Actions, not commands: addAction is scoped to this editor and disposable,
 * while a keybinding from addCommand would outlive it in every later Monaco
 * of the session.
 *
 * Node-loadable on purpose (test/markdown-source-tools.test.ts drives it
 * with a fake editor): relative `.ts` imports, Monaco only as a type and
 * through the context.
 */
import { Network } from "lucide-react";
import type * as Monaco from "monaco-editor";

import type { AttachedSource, SourceContext } from "../registry.ts";
import { DIAGRAM_STARTERS, type DiagramStarter } from "./diagram-starters.ts";
import { documentEnd, planDiagramInsertion } from "./insert-diagram.ts";

/** the source of the edit, as Monaco records it */
export const INSERT_DIAGRAM_SOURCE = "designiq.insert-diagram";

/** the editor action of a starter: "Insert diagram: Flowchart" in the F1 palette */
export const insertDiagramActionId = (starter: DiagramStarter): string =>
  `designiq.markdown.insert-diagram.${starter.id}`;

export function attachMarkdownSource(
  editor: Monaco.editor.IStandaloneCodeEditor,
  { monaco }: SourceContext,
): AttachedSource {
  // whether the user has seen a cursor in the source: it had the focus
  let placed = editor.hasTextFocus();
  const focused = editor.onDidFocusEditorText(() => {
    placed = true;
  });

  const insert = (starter: DiagramStarter): void => {
    const model = editor.getModel();
    if (!model) return;
    const source = model.getValue(monaco.editor.EndOfLinePreference.LF);
    const cursor = placed ? editor.getPosition() : null;
    const { at, text, selection } = planDiagramInsertion(
      source,
      cursor ? { line: cursor.lineNumber, column: cursor.column } : documentEnd(source),
      starter,
    );
    const select = new monaco.Selection(
      selection.startLine,
      selection.startColumn,
      selection.endLine,
      selection.endColumn,
    );
    editor.pushUndoStop();
    editor.executeEdits(
      INSERT_DIAGRAM_SOURCE,
      [{ range: new monaco.Range(at.line, at.column, at.line, at.column), text }],
      [select],
    );
    editor.pushUndoStop();
    editor.revealRangeInCenterIfOutsideViewport(select);
    editor.focus();
  };

  const actions = DIAGRAM_STARTERS.map((starter) =>
    editor.addAction({
      id: insertDiagramActionId(starter),
      label: `Insert diagram: ${starter.label}`,
      run: () => insert(starter),
    }),
  );

  return {
    menus: [
      {
        id: "insert-diagram",
        label: "Insert diagram",
        buttonTitle: "Insert a Mermaid diagram at the cursor, or at the end",
        icon: Network,
        heading: "Mermaid diagram",
        items: DIAGRAM_STARTERS.map(({ id, label, description }) => ({ id, label, description })),
        run: (id) => {
          const starter = DIAGRAM_STARTERS.find((s) => s.id === id);
          if (starter) insert(starter);
        },
      },
    ],
    dispose: () => {
      focused.dispose();
      for (const action of actions) action.dispose();
    },
  };
}
