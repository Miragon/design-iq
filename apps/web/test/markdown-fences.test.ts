/**
 * The validator's reading of a document's fences (@designiq/notations/markdown,
 * a zero-dep scanner) against the tokens the Markdown view renders from
 * (src/notations/markdown/render.ts, markdown-it as it configures it: raw HTML
 * recognised, GFM footnote definitions read where the source has them): the
 * same fences, on the same lines, with the same info string and content. A markdown-it bump, or
 * a change to the view's parser, that reads fences differently fails here
 * until the scanner follows it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownFences } from "@designiq/notations/markdown";

import { parseMarkdown } from "../src/notations/markdown/render.ts";

/** a fence as both readings can state it: map[0] is 0-based, map[1] the line after it */
interface Read {
  line: number;
  endLine: number;
  info: string;
  content: string;
}

const viewReading = (source: string): Read[] =>
  parseMarkdown(source)
    .filter((t) => t.type === "fence")
    .map((t) => ({ line: t.map![0] + 1, endLine: t.map![1], info: t.info.trim(), content: t.content }));

const scannerReading = (source: string): Read[] =>
  markdownFences(source).map(({ line, endLine, info, content }) => ({ line, endLine, info, content }));

const CORPUS: Record<string, string> = {
  "an architecture document": [
    "# Order to cash",
    "",
    "How an order becomes cash. The process itself is [the model](order-to-cash.bpmn).",
    "",
    "```mermaid",
    "C4Context",
    '  Person(customer, "Customer")',
    '  System(shop, "Shop")',
    '  Rel(customer, shop, "orders")',
    "```",
    "",
    "## Steps",
    "",
    "1. The order arrives.",
    "2. It is checked:",
    "",
    "   ```mermaid",
    "   flowchart LR",
    "     check{In stock?} -->|yes| ship",
    "   ```",
    "",
    "3. It ships.",
    "",
    "> **Note**",
    ">",
    "> ```mermaid",
    "> sequenceDiagram",
    ">   Shop->>Bank: charge",
    "> ```",
    "",
  ].join("\n"),
  "tilde fences and closing runs": "~~~ Mermaid theme=dark\npie\n```\n~~~\n\n````md\n```mermaid\nx\n```\n`````\n",
  "unclosed at the end, with and without a last line break": "text\n\n```mermaid\nflowchart LR\n  A --> B",
  "unclosed, then blank lines": "```mermaid\nflowchart LR\n\n\n",
  "a last line of blanks": "```mermaid\npie\n   ",
  "backticks in an info string": "``` a`b\ntext\n```\n\n~~~ a`b\ntext\n~~~\n",
  indent: "   ```mermaid\n   pie\n     x\n y\n   ```\n\n    ```mermaid\n    indented code\n",
  "a paragraph interrupted, a paragraph continued": "Some text\n```mermaid\npie\n```\ntext\n    ```mermaid\n",
  "raw HTML": [
    "<!--",
    "```mermaid",
    "flowchrt",
    "```",
    "-->",
    "",
    "<details>",
    "<summary>Flow</summary>",
    "",
    "```mermaid",
    "pie",
    "```",
    "",
    "</details>",
    '<img src="flow.png">',
    "```",
    "inside the HTML block",
    "```",
    "",
  ].join("\n"),
  "nested lists": "- one\n  - two\n\n    ```mermaid\n    pie\n    ```\n- three\n  ```\n  x\n```\n",
  "a list item ended by an outdented line": "- ```mermaid\n  pie\n\n```\nflowchart LR\n",
  "an empty list item holds one blank line": "-\n\n  ```mermaid\n  pie\n  ```\n\n-\n  ```\n  x\n  ```\n",
  "ordered items, both delimiters": "1) ```mermaid\n   pie\n   ```\n10. ```\n    x\n    ```\n",
  "quotes, nested and lazy": "> > ```mermaid\n> > pie\n> > ```\n\n> para\ncontinued\n> ```\n> x\nlazy\n",
  "a quote in a list item": "- > ```mermaid\n  > pie\n  > ```\n",
  tabs: "-\t```mermaid\n\tpie\n\t```\n\n>\t```\n>\tx\n>\t```\n",
  "CRLF line breaks": "# Title\r\n\r\n```mermaid\r\npie\r\n```\r\n",
  "headings and breaks around fences": "Title\n=====\n```\nx\n```\n* * *\n- - -\n---\n```mermaid\npie\n```\n",
  // a definition is no paragraph: raw HTML or a list may start right after it
  "link reference definitions": [
    "See the [logo].",
    "",
    '[logo]: https://example.com/logo.png "Logo"',
    '<img src="flow.png" alt="">',
    "```mermaid",
    "flowchrt",
    "```",
    "",
    "    code",
    "[r]: <http://x>",
    "10. x",
    "    ```mermaid",
    "    pie",
    "    ```",
    "",
    "[^1]: a footnote definition holds a paragraph, the <img> goes on with it",
    '<img src="a.png">',
    "```mermaid",
    "pie",
    "```",
    "",
    "[bad]: javascript:alert(1)",
    '<img src="b.png">',
    "```",
    "x",
    "```",
  ].join("\n"),
  // a definition holds what is indented four columns past it, blank lines never end it
  "footnote definitions": [
    "The flow[^flow], its states[^states] and a quote[^q].",
    "",
    "[^flow]: The flow as a diagram:",
    "",
    "    ```mermaid",
    "    flowchart LR",
    "      A --> B",
    "    ```",
    "",
    "[^states]: ```mermaid",
    "    stateDiagram-v2",
    "      [*] --> Open",
    "    ```",
    "```mermaid",
    "pie",
    "```",
    "",
    "- [^item]: ```mermaid",
    "        pie",
    "      ```",
    "",
    "> Quoted",
    "[^q]: is a lazy line of the quote, and so is",
    "    ```mermaid",
    "",
    "[^wide]:      ```mermaid",
    "     five blanks after the colon are one",
    "     ```",
    "[^code]:         indented code",
    "    ```mermaid",
    "    pie",
  ].join("\n"),
  // markdown-it parses 49 nested list items and drops the rest of the document at the 50th
  "lists as deep as the view parses": [
    ...Array.from({ length: 49 }, (_, i) => `${"  ".repeat(i)}- item`),
    `${"  ".repeat(49)}\`\`\`mermaid`,
    `${"  ".repeat(49)}pie`,
    `${"  ".repeat(49)}\`\`\``,
    `${"  ".repeat(49)}- item`,
    "",
    "```mermaid",
    "pie",
    "```",
  ].join("\n"),
  // ... and 99 nested quotes; at the 100th it drops the rest of that quote, lazy lines included
  "quotes as deep as the view parses": [
    `${">".repeat(99)} \`\`\`mermaid`,
    `${">".repeat(99)} pie`,
    `${">".repeat(99)} \`\`\``,
    "",
    `${">".repeat(100)} \`\`\`mermaid`,
    `${">".repeat(100)} pie`,
    "lazy",
    `${">".repeat(100)} \`\`\``,
    "",
    `> ${Array.from({ length: 50 }, (_, i) => `${"  ".repeat(i)}- item`).join("\n> ")}`,
    `> ${"  ".repeat(50)}\`\`\`mermaid`,
    "",
    "```mermaid",
    "pie",
    "```",
  ].join("\n"),
};

test("the scanner reads the corpus' fences as the Markdown view does", () => {
  for (const [name, source] of Object.entries(CORPUS)) {
    assert.deepEqual(scannerReading(source), viewReading(source), name);
    assert.ok(viewReading(source).length > 0, `${name}: the case holds a fence`);
  }
});

/** a seeded PRNG (mulberry32): the sweep is the same on every run */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// the lines documents are made of, the containers and HTML blocks included
const LINES = [
  "",
  "",
  "text",
  "# Heading",
  "```mermaid",
  "```",
  "````",
  "~~~",
  "~~~ mermaid",
  "flowchart LR",
  "  A --> B",
  "   ```",
  "  ```mermaid",
  "    indented",
  "- item",
  "-",
  "* item",
  "  - nested",
  "  ```",
  "1. step",
  "2. step",
  "   ```mermaid",
  "> quote",
  ">",
  "> ```mermaid",
  "> ```",
  "> - item",
  "<!--",
  "-->",
  "<details>",
  "</details>",
  "---",
  "* * *",
  "\t- tab",
  "\t```",
  "[r]: http://x",
  "[^1]: note",
  "[^1]: ```mermaid",
  "[^a]:",
  "    ```",
  "- [^1]: x",
];

test("the scanner reads generated documents' fences as the Markdown view does", () => {
  const next = random(254);
  for (let n = 0; n < 3000; n++) {
    const lines = Array.from({ length: 1 + Math.floor(next() * 12) }, () => LINES[Math.floor(next() * LINES.length)]);
    const source = lines.join("\n") + (next() < 0.5 ? "\n" : "");
    assert.deepEqual(scannerReading(source), viewReading(source), JSON.stringify(source));
  }
});
