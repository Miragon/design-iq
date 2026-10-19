/**
 * The Markdown source's tooling (src/notations/markdown/source-tools.ts)
 * driven with a fake Monaco editor: one editor action per starter diagram
 * (the F1 palette), the header menu, and what an insertion does to the
 * editor: ONE executeEdits between two undo stops (one undo step, one change
 * for y-monaco to sync), the label the starter names selected, the focus
 * back in the editor; where it goes while the source has shown no cursor
 * yet; and that dispose takes every action and listener back off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type * as Monaco from "monaco-editor";

import { DIAGRAM_STARTERS } from "../src/notations/markdown/diagram-starters.ts";
import { planDiagramInsertion } from "../src/notations/markdown/insert-diagram.ts";
import {
  attachMarkdownSource,
  INSERT_DIAGRAM_SOURCE,
  insertDiagramActionId,
} from "../src/notations/markdown/source-tools.ts";
import type { SourceContext } from "../src/notations/registry.ts";

// no parameter properties: node strips types, it does not transform them
class FakeRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
    this.startLineNumber = startLineNumber;
    this.startColumn = startColumn;
    this.endLineNumber = endLineNumber;
    this.endColumn = endColumn;
  }
}
class FakeSelection extends FakeRange {}

const LF = 1;
const ctx = {
  monaco: { Range: FakeRange, Selection: FakeSelection, editor: { EndOfLinePreference: { LF } } },
} as unknown as SourceContext;

interface Edit {
  range: FakeRange;
  text: string;
}

/**
 * a Monaco editor as far as the tooling uses it: it records the calls and
 * applies the edits. Its cursor is Monaco's untouched 1:1 unless given, and
 * it has no focus until `focusText` (a click into the source) or `focused`
 */
function fakeEditor(text: string, cursor = { lineNumber: 1, column: 1 }, { focused = false } = {}) {
  const state = {
    text,
    calls: [] as string[],
    edits: [] as Edit[][],
    selection: undefined as FakeSelection | undefined,
  };
  const actions = new Map<string, Monaco.editor.IActionDescriptor & { disposed: boolean }>();
  const focusListeners = new Set<() => void>();
  let hasFocus = focused;
  const focusText = () => {
    hasFocus = true;
    for (const listener of [...focusListeners]) listener();
  };
  let model: { getValue(eol: number): string } | null = {
    getValue: (eol) => {
      assert.equal(eol, LF, "the document is read with \\n line breaks");
      return state.text;
    },
  };
  const editor = {
    getModel: () => model,
    getPosition: () => cursor,
    pushUndoStop: () => {
      state.calls.push("pushUndoStop");
      return true;
    },
    executeEdits: (source: string, edits: Edit[], end: FakeSelection[]) => {
      state.calls.push(`executeEdits:${source}`);
      state.edits.push(edits);
      for (const { range, text: inserted } of edits) {
        const lines = state.text.split("\n");
        const offset =
          lines.slice(0, range.startLineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + range.startColumn - 1;
        state.text = state.text.slice(0, offset) + inserted + state.text.slice(offset);
      }
      state.selection = end[0];
      return true;
    },
    revealRangeInCenterIfOutsideViewport: () => state.calls.push("reveal"),
    focus: () => {
      state.calls.push("focus");
      focusText();
    },
    hasTextFocus: () => hasFocus,
    onDidFocusEditorText: (listener: () => void) => {
      focusListeners.add(listener);
      return { dispose: () => void focusListeners.delete(listener) };
    },
    addAction: (descriptor: Monaco.editor.IActionDescriptor) => {
      const action = { ...descriptor, disposed: false };
      actions.set(descriptor.id, action);
      return { dispose: () => void (action.disposed = true) };
    },
  };
  return {
    editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    state,
    actions,
    focusListeners,
    focusText,
    dispose: () => void (model = null),
  };
}

/** the text a single-line selection covers */
const selectedText = (text: string, s: FakeSelection): string =>
  text.split("\n")[s.startLineNumber - 1]!.slice(s.startColumn - 1, s.endColumn - 1);

test("one editor action per starter diagram, for the F1 palette, and dispose takes them all back off", () => {
  const { editor, actions, focusListeners } = fakeEditor("");
  const tools = attachMarkdownSource(editor, ctx);
  assert.deepEqual(
    [...actions.values()].map((a) => [a.id, a.label]),
    DIAGRAM_STARTERS.map((s) => [insertDiagramActionId(s), `Insert diagram: ${s.label}`]),
  );
  // actions, not commands: no keybinding is added (it would outlive this editor)
  assert.ok([...actions.values()].every((a) => a.keybindings === undefined));
  assert.equal(focusListeners.size, 1);
  tools.dispose();
  assert.ok([...actions.values()].every((a) => a.disposed));
  assert.equal(focusListeners.size, 0, "the focus listener is gone too");
});

test("an insertion is ONE executeEdits between two undo stops, then the label selected and the focus back", async () => {
  const text = "# Order to cash\n\nHow an order becomes cash.\n";
  const cursor = { lineNumber: 3, column: 8 };
  const { editor, state, actions, focusText } = fakeEditor(text, cursor);
  attachMarkdownSource(editor, ctx);
  focusText();
  const flowchart = DIAGRAM_STARTERS.find((s) => s.id === "flowchart")!;
  await actions.get(insertDiagramActionId(flowchart))!.run(editor);

  assert.deepEqual(state.calls, [
    "pushUndoStop",
    `executeEdits:${INSERT_DIAGRAM_SOURCE}`,
    "pushUndoStop",
    "reveal",
    "focus",
  ]);
  const plan = planDiagramInsertion(text, { line: 3, column: 8 }, flowchart);
  assert.deepEqual(state.edits, [
    [{ range: new FakeRange(plan.at.line, plan.at.column, plan.at.line, plan.at.column), text: plan.text }],
  ]);
  assert.equal(state.text, text + "\n```mermaid\n" + flowchart.body + "```\n");
  assert.equal(selectedText(state.text, state.selection!), flowchart.select);
});

test("a source that has shown no cursor yet: the diagram goes to the end, not above the title", () => {
  // Monaco draws no cursor before the focus, and its position is still 1:1
  const text = "# Order to cash\n\nHow an order becomes cash.\n";
  const flowchart = DIAGRAM_STARTERS.find((s) => s.id === "flowchart")!;
  const fence = "```mermaid\n" + flowchart.body + "```\n";
  const untouched = fakeEditor(text);
  const tools = attachMarkdownSource(untouched.editor, ctx);
  tools.menus![0]!.run(flowchart.id);
  assert.equal(untouched.state.text, text + "\n" + fence);
  assert.equal(selectedText(untouched.state.text, untouched.state.selection!), flowchart.select);

  // once the source has had the focus, its cursor counts, at 1:1 too
  const clicked = fakeEditor(text);
  const clickedTools = attachMarkdownSource(clicked.editor, ctx);
  clicked.focusText();
  clickedTools.menus![0]!.run(flowchart.id);
  assert.equal(clicked.state.text, fence + "\n" + text);

  // and so it does when the source has the focus as the tooling attaches
  const focused = fakeEditor(text, undefined, { focused: true });
  attachMarkdownSource(focused.editor, ctx).menus![0]!.run(flowchart.id);
  assert.equal(focused.state.text, fence + "\n" + text);
});

test("the header menu lists the starters, and its entries insert as the actions do", () => {
  const { editor, state } = fakeEditor("");
  const tools = attachMarkdownSource(editor, ctx);
  assert.equal(tools.menus?.length, 1);
  const menu = tools.menus![0]!;
  assert.equal(menu.label, "Insert diagram");
  assert.deepEqual(
    menu.items,
    DIAGRAM_STARTERS.map(({ id, label, description }) => ({ id, label, description })),
  );
  const sequence = DIAGRAM_STARTERS.find((s) => s.id === "sequence")!;
  menu.run(sequence.id);
  assert.equal(state.text, "```mermaid\n" + sequence.body + "```\n");
  assert.equal(selectedText(state.text, state.selection!), sequence.select);
  // an id the menu does not have edits nothing
  menu.run("no-such-diagram");
  assert.equal(state.edits.length, 1);
});

test("an editor without a model (disposed) is left alone", () => {
  const { editor, state, dispose } = fakeEditor("Text\n");
  const tools = attachMarkdownSource(editor, ctx);
  dispose();
  tools.menus![0]!.run(DIAGRAM_STARTERS[0]!.id);
  assert.deepEqual(state.calls, []);
  assert.equal(state.text, "Text\n");
});
