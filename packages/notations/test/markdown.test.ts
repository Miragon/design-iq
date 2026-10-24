/**
 * The fenced code blocks of a Markdown document (../markdown.ts), the reading
 * the validator's ```mermaid check stands on: where a fence opens and closes,
 * its content and the document lines it reports. Fences inside lists and
 * block quotes are pinned case by case here; apps/web's
 * test/markdown-fences.test.ts holds the same reading against markdown-it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownFences } from "../markdown.ts";

/** the fences as line, info and content (the fields the checks read) */
const fences = (source: string) => markdownFences(source).map(({ line, info, content }) => ({ line, info, content }));

test("markdownFences: backtick and tilde fences, with their line, info string and language", () => {
  const doc = [
    "# Order to cash", // 1
    "", // 2
    "```mermaid", // 3
    "flowchart LR", // 4
    "  A --> B", // 5
    "```", // 6
    "", // 7
    "~~~ Mermaid  theme=dark ", // 8
    "sequenceDiagram", // 9
    "~~~", // 10
    "", // 11
    "```", // 12
    "plain", // 13
    "```", // 14
  ].join("\n");
  assert.deepEqual(markdownFences(doc), [
    { line: 3, endLine: 6, info: "mermaid", lang: "mermaid", content: "flowchart LR\n  A --> B\n", closed: true },
    {
      line: 8,
      endLine: 10,
      info: "Mermaid  theme=dark",
      lang: "mermaid",
      content: "sequenceDiagram\n",
      closed: true,
    },
    { line: 12, endLine: 14, info: "", lang: "", content: "plain\n", closed: true },
  ]);
  // CRLF and CR read as line breaks; no fence, no result
  assert.deepEqual(fences("```mermaid\r\npie\r\n```\r\n"), [{ line: 1, info: "mermaid", content: "pie\n" }]);
  assert.deepEqual(markdownFences("# notes\n\nno diagram here\n"), []);
  assert.deepEqual(markdownFences(""), []);
});

test("markdownFences: the closing run is the same character, at least as long, and nothing else", () => {
  // a shorter run, the other character and a run with text after it are content
  assert.deepEqual(fences("````mermaid\n```\n~~~~\n```` x\nflowchart LR\n`````\nafter\n"), [
    { line: 1, info: "mermaid", content: "```\n~~~~\n```` x\nflowchart LR\n" },
  ]);
  // an info string with a backtick opens no backtick fence (it is inline code), a tilde one does
  assert.deepEqual(fences("``` a`b\ntext\n"), []);
  assert.deepEqual(fences("~~~ a`b\ntext\n~~~\n"), [{ line: 1, info: "a`b", content: "text\n" }]);
  // two runs only: "``" is inline code
  assert.deepEqual(fences("``\nx\n``\n"), []);
});

test("markdownFences: an unclosed fence runs to the end of the document", () => {
  assert.deepEqual(markdownFences("text\n\n```mermaid\nflowchart LR\n  A --> B\n"), [
    { line: 3, endLine: 5, info: "mermaid", lang: "mermaid", content: "flowchart LR\n  A --> B\n", closed: false },
  ]);
  // an opening run on the last line: an empty fence (the line itself)
  assert.deepEqual(markdownFences("```mermaid"), [
    { line: 1, endLine: 1, info: "mermaid", lang: "mermaid", content: "", closed: false },
  ]);
});

test("markdownFences: up to three spaces of indent, which the content loses as well", () => {
  assert.deepEqual(fences("   ```mermaid\n   flowchart LR\n     A --> B\n A\n   ```\n"), [
    { line: 1, info: "mermaid", content: "flowchart LR\n  A --> B\nA\n" },
  ]);
  // four spaces are indented code, never a fence
  assert.deepEqual(fences("    ```mermaid\n    flowchart LR\n    ```\n"), []);
  // ... unless a paragraph is open: then the line continues it
  assert.deepEqual(fences("text\n    ```mermaid\n"), []);
});

test("markdownFences: a fence interrupts a paragraph, raw HTML hides one", () => {
  assert.deepEqual(fences("Some text\n```mermaid\npie\n```\n"), [{ line: 2, info: "mermaid", content: "pie\n" }]);
  // a commented-out diagram is no fence (the view drops the comment)
  assert.deepEqual(fences("<!--\n```mermaid\nflowchrt\n```\n-->\n"), []);
  // a block-level tag holds the lines up to the next blank line: a fence
  // after that blank line is a fence again (GitHub's <details> idiom)
  assert.deepEqual(fences("<details>\n<summary>Flow</summary>\n```mermaid\npie\n```\n</details>\n"), []);
  assert.deepEqual(fences("<details>\n<summary>Flow</summary>\n\n```mermaid\npie\n```\n\n</details>\n"), [
    { line: 4, info: "mermaid", content: "pie\n" },
  ]);
});

test("markdownFences: inside a list item the fence loses the item's content indent", () => {
  const doc = [
    "1. Order received", // 1
    "", // 2
    "   ```mermaid", // 3
    "   flowchart LR", // 4
    "     A --> B", // 5
    "   ```", // 6
    "2. Order shipped", // 7
    "   - nested", // 8
    "", // 9
    "     ```mermaid", // 10
    "     pie", // 11
    "     ```", // 12
  ].join("\n");
  assert.deepEqual(fences(doc), [
    { line: 3, info: "mermaid", content: "flowchart LR\n  A --> B\n" },
    { line: 10, info: "mermaid", content: "pie\n" },
  ]);
  // the item's first line may open the fence itself
  assert.deepEqual(fences("- ```mermaid\n  pie\n  ```\n"), [{ line: 1, info: "mermaid", content: "pie\n" }]);
  // a line indented less than the item's content ends the item, and with it
  // the unclosed fence: the run below opens a fence of its own
  assert.deepEqual(markdownFences("- ```mermaid\n  pie\n\n```\nflowchart LR\n"), [
    { line: 1, endLine: 3, info: "mermaid", lang: "mermaid", content: "pie\n\n", closed: false },
    { line: 4, endLine: 5, info: "", lang: "", content: "flowchart LR\n", closed: false },
  ]);
  // a run indented less than the item's content is no fence of the item:
  // after a paragraph it still opens one, after the item
  assert.deepEqual(fences("- item\n```mermaid\npie\n```\n"), [{ line: 2, info: "mermaid", content: "pie\n" }]);
});

test("markdownFences: inside a block quote the fence loses the '>' of every line", () => {
  assert.deepEqual(fences("> Note\n>\n> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n"), [
    { line: 3, info: "mermaid", content: "flowchart LR\n  A --> B\n" },
  ]);
  // nested quotes, and a quote inside a list item
  assert.deepEqual(fences("> > ```mermaid\n> > pie\n> > ```\n"), [{ line: 1, info: "mermaid", content: "pie\n" }]);
  assert.deepEqual(fences("- > ```mermaid\n  > pie\n  > ```\n"), [{ line: 1, info: "mermaid", content: "pie\n" }]);
  // a line without its '>' ends the quote and the fence (a fence takes no
  // lazy continuation line); the text below is a paragraph of its own
  assert.deepEqual(markdownFences("> ```mermaid\n> pie\nflowchart LR\n"), [
    { line: 1, endLine: 2, info: "mermaid", lang: "mermaid", content: "pie\n", closed: false },
  ]);
  // a paragraph takes one: the run on the lazy line is text, the quote goes on
  assert.deepEqual(fences("> para\ncontinued\n> ```mermaid\n> pie\n> ```\n"), [
    { line: 3, info: "mermaid", content: "pie\n" },
  ]);
});

test("markdownFences: a link reference definition is no paragraph, so raw HTML or a list may follow it", () => {
  // after a paragraph, an <img> line is text and the fence below opens; after
  // a definition the <img> opens an HTML block, which holds the fence
  assert.deepEqual(fences('See the logo.\n<img src="flow.png">\n```mermaid\npie\n```\n'), [
    { line: 3, info: "mermaid", content: "pie\n" },
  ]);
  assert.deepEqual(
    fences('[logo]: https://example.com/logo.png "Logo"\n<img src="flow.png">\n```mermaid\npie\n```\n'),
    [],
  );
  // an ordered item not starting at 1 interrupts no paragraph, but follows a definition
  assert.deepEqual(fences("[r]: <http://x>\n10. x\n    ```mermaid\n    pie\n    ```\n"), [
    { line: 3, info: "mermaid", content: "pie\n" },
  ]);
  // a footnote definition holds a paragraph, which the <img> line goes on with;
  // a link the view refuses is no definition but paragraph text
  assert.deepEqual(fences('[^1]: note\n<img src="a.png">\n```mermaid\npie\n```\n'), [
    { line: 3, info: "mermaid", content: "pie\n" },
  ]);
  assert.deepEqual(fences('[x]: javascript:alert(1)\n<img src="a.png">\n```mermaid\npie\n```\n'), [
    { line: 3, info: "mermaid", content: "pie\n" },
  ]);
});

test("markdownFences: a footnote definition holds the fences indented four columns past it", () => {
  // blank lines never end a definition; a line indented less does
  assert.deepEqual(
    fences("[^1]: The flow:\n\n    ```mermaid\n    pie\n\n      x\n    ```\n```mermaid\nflowchart LR\n"),
    [
      { line: 3, info: "mermaid", content: "pie\n\n  x\n" },
      { line: 8, info: "mermaid", content: "flowchart LR\n" },
    ],
  );
  assert.deepEqual(fences("[^1]: note\n\n```mermaid\n    pie\n```\n"), [
    { line: 3, info: "mermaid", content: "    pie\n" },
  ]);
  // a fence on the definition's own line: its content loses the definition's
  // four columns and the blanks after the colon, which count from the fifth on
  assert.deepEqual(fences("[^1]: ```mermaid\n     pie\n    ```\n"), [{ line: 1, info: "mermaid", content: "pie\n" }]);
  assert.deepEqual(fences("[^1]:      ```mermaid\n     pie\n     ```\n"), [
    { line: 1, info: "mermaid", content: "pie\n" },
  ]);
  assert.deepEqual(fences("[^1]:         ```mermaid\n"), []);
  // in a list item, the definition's four columns count past the item's content
  assert.deepEqual(fences("- [^1]: ```mermaid\n        pie\n      ```\n"), [
    { line: 1, info: "mermaid", content: " pie\n" },
  ]);
  // it interrupts a paragraph, but a quote reads it as a lazy line
  assert.deepEqual(fences("Text\n[^1]: note\n\n    ```mermaid\n    pie\n    ```\n"), [
    { line: 4, info: "mermaid", content: "pie\n" },
  ]);
  assert.deepEqual(fences("> Quote\n[^1]: note\n    ```mermaid\n    pie\n"), []);
  // a blank in the label: no definition, but paragraph text
  assert.deepEqual(fences("[^a b]: note\n\n    ```mermaid\n"), []);
});

test("markdownFences: content nested deeper than the view parses holds no fence", () => {
  const lists = (depth: number) => Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}- x\n`).join("");
  const fence = "```mermaid\npie\n```\n";
  // 49 list items deep a fence counts; at the 50th the rest of the document is dropped
  assert.deepEqual(fences(`${lists(49)}\n${fence}`), [{ line: 51, info: "mermaid", content: "pie\n" }]);
  assert.deepEqual(fences(`${lists(50)}\n${fence}`), []);
  // 100 quotes deep the rest of the quote is dropped, and what follows it counts
  const quoted = (depth: number) => ["```mermaid", "pie", "```"].map((l) => `${">".repeat(depth)} ${l}\n`).join("");
  assert.deepEqual(fences(quoted(99)), [{ line: 1, info: "mermaid", content: "pie\n" }]);
  assert.deepEqual(fences(`${quoted(100)}\n${fence}`), [{ line: 5, info: "mermaid", content: "pie\n" }]);
});

test("markdownFences: linear on deep nesting and long lines, up to the save gate's 8 MB", () => {
  // the validator scans a document on every save, on the host's event loop:
  // no shape of document may cost it seconds
  const MB8 = 8_000_000;
  const lists = (depth: number) => Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}- x\n`).join("");
  const fill = (head: string, line: string) => head + line.repeat(Math.floor((MB8 - head.length) / line.length));
  const documents = {
    "lists 1500 deep": fill(lists(1500), `${" ".repeat(3000)}y\n`),
    "lists 49 deep, each line continuing them": fill(lists(49), `${" ".repeat(1000)}y\n`),
    "lists in a quote, too deep for the view": fill(lists(50).replace(/^(?=.)/gm, "> "), `> ${" ".repeat(1000)}y\n`),
    "footnote definitions 99 deep, each line continuing them": fill(
      `${"[^1]: ".repeat(99)}x\n`,
      `${" ".repeat(396)}y\n`,
    ),
    "one line of blanks": `${lists(49)}${" ".repeat(MB8)}\n`,
  };
  for (const [name, source] of Object.entries(documents)) {
    const start = performance.now();
    markdownFences(source);
    const ms = performance.now() - start;
    assert.ok(ms < 1000, `${name}: ${Math.round(ms)} ms`);
  }
});
