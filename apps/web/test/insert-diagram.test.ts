/**
 * Where "Insert diagram" puts a ```mermaid fence (src/notations/markdown/
 * insert-diagram.ts): at the cursor as a block of its own, after the
 * cursor's block when the cursor is in its text (in a list: after the
 * cursor's item, with everything nested in it), blank lines around it as
 * needed, never inside a block the view reads as one, and the exact text
 * that does it. Every result is read back with the validator's fence
 * scanner and the view's own parse.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownFences } from "@designiq/notations/markdown";

import {
  type DiagramInsertion,
  type DocPosition,
  type DocRange,
  documentEnd,
  type InsertedDiagram,
  planDiagramInsertion,
} from "../src/notations/markdown/insert-diagram.ts";
import { parseMarkdown } from "../src/notations/markdown/render.ts";

const DIAGRAM: InsertedDiagram = { body: "flowchart LR\n  a[Start] --> b[End]\n", select: "Start" };
const FENCE = "```mermaid\nflowchart LR\n  a[Start] --> b[End]\n```\n";

/** the document once the insertion is made */
function apply(text: string, insertion: DiagramInsertion): string {
  const lines = text.split("\n");
  const offset = lines.slice(0, insertion.at.line - 1).reduce((n, line) => n + line.length + 1, 0);
  const at = offset + insertion.at.column - 1;
  return text.slice(0, at) + insertion.text + text.slice(at);
}

/** the text of a single-line range */
function selected(text: string, range: DocRange): string {
  assert.equal(range.startLine, range.endLine, "the selection stays on one line");
  return text.split("\n")[range.startLine - 1]!.slice(range.startColumn - 1, range.endColumn - 1);
}

/** insert DIAGRAM at the cursor: the document after it, and where the fence went */
function insert(text: string, cursor: DocPosition, diagram = DIAGRAM) {
  const insertion = planDiagramInsertion(text, cursor, diagram);
  const result = apply(text, insertion);
  // whatever the case: the scanner reads the diagram where the plan says
  const fence = markdownFences(result).find((f) => f.line === insertion.fenceLine);
  assert.ok(fence, `no fence on line ${insertion.fenceLine} of:\n${result}`);
  assert.deepEqual(
    { lang: fence.lang, content: fence.content, closed: fence.closed },
    {
      lang: "mermaid",
      content: diagram.body,
      closed: true,
    },
  );
  return { insertion, result };
}

test("an empty document becomes the diagram, ending with a line break", () => {
  const { insertion, result } = insert("", { line: 1, column: 1 });
  assert.deepEqual(insertion.at, { line: 1, column: 1 });
  assert.equal(insertion.text, FENCE);
  assert.equal(result, FENCE);
  assert.equal(insertion.fenceLine, 1);
});

test("the cursor selects the diagram's `select` text", () => {
  const { insertion, result } = insert("", { line: 1, column: 1 });
  assert.deepEqual(insertion.selection, { startLine: 3, startColumn: 5, endLine: 3, endColumn: 10 });
  assert.equal(selected(result, insertion.selection), "Start");
  // without a label to select, the cursor goes to the end of the diagram's first line
  const bare = planDiagramInsertion("", { line: 1, column: 1 }, { body: DIAGRAM.body });
  assert.deepEqual(bare.selection, { startLine: 2, startColumn: 13, endLine: 2, endColumn: 13 });
  const missing = planDiagramInsertion("", { line: 1, column: 1 }, { body: DIAGRAM.body, select: "Nowhere" });
  assert.deepEqual(missing.selection, bare.selection);
});

test("at the start of a block: before it, a blank line after the diagram", () => {
  const text = "# Title\n\nSome text.\n";
  const { insertion, result } = insert(text, { line: 1, column: 1 });
  assert.deepEqual(insertion.at, { line: 1, column: 1 });
  assert.equal(insertion.text, FENCE + "\n");
  assert.equal(result, FENCE + "\n# Title\n\nSome text.\n");
  assert.equal(selected(result, insertion.selection), "Start");
  // the cursor in a line's indent is at its start too
  assert.equal(
    insert("Intro\n\n   Indented text.\n", { line: 3, column: 3 }).result,
    "Intro\n\n" + FENCE + "\n   Indented text.\n",
  );
});

test("in the middle of a line: after its block, blank lines around the diagram", () => {
  const text = "# Title\n\nSome text here.\n## Next\n";
  const { insertion, result } = insert(text, { line: 3, column: 6 });
  assert.deepEqual(insertion.at, { line: 4, column: 1 });
  assert.equal(insertion.text, "\n" + FENCE + "\n");
  assert.equal(result, "# Title\n\nSome text here.\n\n" + FENCE + "\n## Next\n");
  assert.equal(insertion.fenceLine, 5);
  assert.equal(selected(result, insertion.selection), "Start");
  // at the end of the line alike
  assert.equal(insert(text, { line: 3, column: 16 }).result, result);
});

test("a paragraph over several lines stays whole: the diagram goes after it", () => {
  // an indented line in it would read as code at the start of a block of its own
  const text = "Some text here,\nwritten over\n    three lines.\n\nAfter\n";
  const after = "Some text here,\nwritten over\n    three lines.\n\n" + FENCE + "\nAfter\n";
  for (const cursor of [
    { line: 1, column: 6 },
    { line: 2, column: 1 },
    { line: 3, column: 3 },
    { line: 3, column: 17 },
  ]) {
    assert.equal(insert(text, cursor).result, after, JSON.stringify(cursor));
  }
  // the cursor at its start: before it
  assert.equal(insert(text, { line: 1, column: 1 }).result, FENCE + "\n" + text);
});

test("blank lines already there are not doubled", () => {
  // the cursor on a blank line: the diagram goes at it
  assert.equal(insert("One.\n\nTwo.\n", { line: 2, column: 1 }).result, "One.\n\n" + FENCE + "\nTwo.\n");
  // a blank line after the cursor's line already parts it from the text below
  assert.equal(insert("One.\n\nTwo.\n", { line: 1, column: 5 }).result, "One.\n\n" + FENCE + "\nTwo.\n");
});

test("at the end of a document without a final line break: the line is ended, and the document ends with one", () => {
  const text = "# Title\n\nLast line";
  const { insertion, result } = insert(text, { line: 3, column: 10 });
  assert.deepEqual(insertion.at, { line: 3, column: 10 });
  assert.equal(insertion.text, "\n\n" + FENCE);
  assert.equal(result, "# Title\n\nLast line\n\n" + FENCE);
  assert.equal(insertion.fenceLine, 5);
  assert.equal(selected(result, insertion.selection), "Start");
  // with a final line break, from the end of the last line or the empty line after it
  const broken = "# Title\n\nLast line\n";
  assert.equal(insert(broken, { line: 3, column: 10 }).result, "# Title\n\nLast line\n\n" + FENCE);
  assert.equal(insert(broken, { line: 4, column: 1 }).result, "# Title\n\nLast line\n\n" + FENCE);
});

test("inside a fence: after it, wherever the cursor is in it but at its very start", () => {
  const text = "Intro\n\n```js\nconst a = 1;\n```\nAfter\n";
  const after = "Intro\n\n```js\nconst a = 1;\n```\n\n" + FENCE + "\nAfter\n";
  for (const cursor of [
    { line: 3, column: 4 },
    { line: 4, column: 1 },
    { line: 4, column: 7 },
    { line: 5, column: 4 },
  ]) {
    assert.equal(insert(text, cursor).result, after, JSON.stringify(cursor));
  }
  // the cursor before the fence's opening run: the diagram goes before the fence
  assert.equal(
    insert(text, { line: 3, column: 1 }).result,
    "Intro\n\n" + FENCE + "\n```js\nconst a = 1;\n```\nAfter\n",
  );
});

test("inside an unclosed fence: before it, since it runs to the end of the document", () => {
  const text = "Intro\n\n```js\nconst a = 1;\n";
  const { result } = insert(text, { line: 4, column: 3 });
  assert.equal(result, "Intro\n\n" + FENCE + "\n```js\nconst a = 1;\n");
  // so does an unclosed HTML comment, which runs to the end as well
  assert.equal(
    insert("<!-- a note\nstill the note", { line: 2, column: 3 }).result,
    FENCE + "\n<!-- a note\nstill the note",
  );
});

test("in a list: after the cursor's item, at the margin; a numbered list goes on at its number", () => {
  const text = "Steps:\n\n1. The order arrives.\n2. It is checked.\n3. It ships.\n";
  const { result } = insert(text, { line: 4, column: 8 });
  assert.equal(result, "Steps:\n\n1. The order arrives.\n2. It is checked.\n\n" + FENCE + "\n3. It ships.\n");
  const tokens = parseMarkdown(result);
  const lists = tokens.filter((t) => t.type === "ordered_list_open");
  assert.equal(lists.length, 2);
  assert.equal(lists[0]!.attrGet("start"), null);
  assert.equal(Number(lists[1]!.attrGet("start")), 3);
  assert.ok(tokens.some((t) => t.type === "fence" && t.info === "mermaid" && t.level === 0));
  // a bulleted list alike
  assert.equal(insert("- one\n- two\n", { line: 1, column: 4 }).result, "- one\n\n" + FENCE + "\n- two\n");
  // a quote is one block: after it
  assert.equal(
    insert("> one\n> two\n\nAfter\n", { line: 1, column: 4 }).result,
    "> one\n> two\n\n" + FENCE + "\nAfter\n",
  );
});

test("an item keeps what is nested in it, indented however far: child lists, fences, further lines", () => {
  // four spaces in (Monaco's Tab): at the margin they would read as indented code
  const nested = "- Order received\n    - Check stock\n    - Ship\n- Invoice sent\n";
  const afterItem = "- Order received\n    - Check stock\n    - Ship\n\n" + FENCE + "\n- Invoice sent\n";
  for (const cursor of [
    { line: 1, column: 5 },
    { line: 2, column: 9 },
    { line: 3, column: 1 },
  ]) {
    assert.equal(insert(nested, cursor).result, afterItem, JSON.stringify(cursor));
  }
  // the cursor at the item's start: before it
  assert.equal(insert(nested, { line: 1, column: 1 }).result, FENCE + "\n" + nested);
  // a child indented with a tab
  assert.equal(
    insert("- Order received\n\t- Check stock\n", { line: 1, column: 5 }).result,
    "- Order received\n\t- Check stock\n\n" + FENCE,
  );
  // a fence in the item, four spaces in, and in a loose item after a blank line
  const fenced = "1.  Step one\n    ```js\n    run();\n    ```\n2.  Step two\n";
  assert.equal(
    insert(fenced, { line: 1, column: 6 }).result,
    "1.  Step one\n    ```js\n    run();\n    ```\n\n" + FENCE + "\n2.  Step two\n",
  );
  assert.equal(
    insert("- item\n\n    ```js\n    x\n    ```\n", { line: 1, column: 4 }).result,
    "- item\n\n    ```js\n    x\n    ```\n\n" + FENCE,
  );
  // a line that goes on with the item's text
  assert.equal(
    insert("-   Item one\n    continued here\n", { line: 1, column: 5 }).result,
    "-   Item one\n    continued here\n\n" + FENCE,
  );
});

test("a table, a setext heading, raw HTML and indented code stay whole", () => {
  const table = "| Step | Owner |\n| ---- | ----- |\n| Check | Sales |\n| Ship | Ops |\n\nAfter\n";
  const afterTable = "| Step | Owner |\n| ---- | ----- |\n| Check | Sales |\n| Ship | Ops |\n\n" + FENCE + "\nAfter\n";
  assert.equal(insert(table, { line: 3, column: 5 }).result, afterTable);
  assert.equal(insert(table, { line: 1, column: 3 }).result, afterTable);
  assert.equal(insert(table, { line: 1, column: 1 }).result, FENCE + "\n" + table);

  assert.equal(insert("Title\n=====\nText\n", { line: 1, column: 3 }).result, "Title\n=====\n\n" + FENCE + "\nText\n");
  assert.equal(
    insert("<div>\nraw\n</div>\n\nText\n", { line: 2, column: 2 }).result,
    "<div>\nraw\n</div>\n\n" + FENCE + "\nText\n",
  );
  assert.equal(
    insert("Text\n\n    code one\n    code two\n\nMore\n", { line: 3, column: 7 }).result,
    "Text\n\n    code one\n    code two\n\n" + FENCE + "\nMore\n",
  );
});

test("what the blocks do not show, the view's reading of the rest decides: a link definition keeps its title", () => {
  // markdown-it gives a link reference definition no block: the diagram after
  // its first line would part it from its title, which then reads as text
  const text = 'Intro\n\n[model]: order-to-cash.bpmn\n  "The process"\n\nSee [model].\n';
  assert.equal(
    insert(text, { line: 3, column: 5 }).result,
    "Intro\n\n" + FENCE + '\n[model]: order-to-cash.bpmn\n  "The process"\n\nSee [model].\n',
  );
});

test("Windows line breaks read as line breaks", () => {
  const { insertion } = insert("One.\r\n\r\nTwo.\r\n", { line: 1, column: 3 });
  assert.deepEqual(insertion.at, { line: 2, column: 1 });
  assert.equal(insertion.text, "\n" + FENCE);
});

test("the end of the document, for a source that has shown no cursor yet", () => {
  assert.deepEqual(documentEnd(""), { line: 1, column: 1 });
  assert.deepEqual(documentEnd("# Title\n"), { line: 2, column: 1 });
  assert.deepEqual(documentEnd("# Title\r\n\r\nLast line"), { line: 3, column: 10 });
  assert.equal(insert("# Title\n", documentEnd("# Title\n")).result, "# Title\n\n" + FENCE);
  assert.equal(insert("# Title", documentEnd("# Title")).result, "# Title\n\n" + FENCE);
});

test("anywhere in a document, the diagram reads as one and every other block stays as it was", () => {
  const text = [
    "# Order to cash",
    "",
    "How an order becomes cash, see [the model](order-to-cash.bpmn).",
    "Written over two lines.",
    "",
    "```mermaid",
    "flowchart LR",
    "  a --> b",
    "```",
    "",
    "1. The order arrives.",
    "2. It is checked:",
    "",
    "   ```js",
    "   check(order);",
    "   ```",
    "",
    "- Order received",
    "    - Check stock",
    "\t- Ship",
    "",
    "- An item",
    "",
    "    ```js",
    "    ship(order);",
    "    ```",
    "",
    "1.  Step one",
    "    ```js",
    "    run();",
    "    ```",
    "2.  Step two",
    "    continued here",
    "",
    "First line of a paragraph",
    "    second line",
    "",
    "> **Note**",
    "> ```text",
    "> quoted",
    "> ```",
    "",
    "| A | B |",
    "| - | - |",
    "| 1 | 2 |",
    "<!-- a comment",
    "over lines -->",
    "",
    "    indented code",
    "",
    "~~~",
    "tilde fence",
  ].join("\n");
  // the validator's reading of the other fences ...
  const fences = (source: string, newLine = 0) =>
    markdownFences(source)
      .filter((f) => f.line !== newLine)
      .map(({ info, content, closed }) => ({ info, content, closed }));
  // ... and the view's of every other block, a list's edges aside: a list
  // the diagram ends reads as two, its items as they were
  const blocks = (source: string, newLine = 0) =>
    parseMarkdown(source)
      .filter((t) => !/_list_(open|close)$/.test(t.type) && !(t.type === "fence" && t.map?.[0] === newLine - 1))
      .map(({ type, level, info, content }) => ({ type, level, info, content: content.replace(/\n$/, "") }));
  const before = { fences: fences(text), blocks: blocks(text) };
  const lines = text.split("\n");
  for (let line = 1; line <= lines.length; line++) {
    const length = lines[line - 1]!.length;
    // the line's start, its middle and its end
    for (const column of new Set([1, Math.ceil(length / 2) + 1, length + 1])) {
      const { insertion, result } = insert(text, { line, column });
      const after = { fences: fences(result, insertion.fenceLine), blocks: blocks(result, insertion.fenceLine) };
      assert.deepEqual(after, before, `cursor ${line}:${column}`);
    }
  }
});
