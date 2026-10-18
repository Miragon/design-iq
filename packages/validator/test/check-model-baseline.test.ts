/**
 * The per-mediaKind baseline gate (checkModelBaseline) + its CLI wiring: a
 * model of ANY registered notation must at minimum parse — before this, a
 * broken .tt/.vc.json passed `pnpm validate` untouched because discovery
 * never reached non-BPMN/DMN files. DSL notations are deliberately lenient
 * (the extractors ignore unknown lines), which the cases pin.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { templateFor } from "@designiq/notations/templates";

import { checkModelBaseline } from "../src/validate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE = resolve(HERE, "..", "src", "cli.ts");

function run(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [VALIDATE, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** a minimal content repo whose models folder holds exactly `files` */
function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "validator-baseline-"));
  writeFileSync(join(dir, "designiq.yml"), "models: models\n");
  mkdirSync(join(dir, "models"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, "models", name), content);
  }
  return dir;
}

test("checkModelBaseline: json parses or errors, dsl stays lenient", () => {
  assert.deepEqual(checkModelBaseline("{}", { notation: "team-topology" }), []);
  const broken = checkModelBaseline("{ nope", { file: "models/t.tt", notation: "team-topology" });
  assert.equal(broken.length, 1);
  assert.equal(broken[0]?.severity, "ERROR");
  assert.equal(broken[0]?.file, "models/t.tt");
  assert.match(broken[0]?.message ?? "", /not parseable as JSON/);
  // wardley's regex parser ignores garbage lines — no throw, no finding
  assert.deepEqual(checkModelBaseline("!!! not a map !!!", { notation: "wardley" }), []);
  // same for the .storm DSL — uninterpretable lines are passthrough there too
  assert.deepEqual(
    checkModelBaseline("!!! not a board !!!\nevent Order Placed [1, 2]", { notation: "event-storming" }),
    [],
  );
  // a context map is JSON: unparsable = ERROR, the blank template is baseline-clean
  const cm = checkModelBaseline("{ nope", { file: "models/m.cm.json", notation: "context-map" });
  assert.equal(cm[0]?.severity, "ERROR");
  assert.match(cm[0]?.message ?? "", /not parseable as JSON/);
  assert.deepEqual(checkModelBaseline(templateFor("context-map", "m", "M") ?? "", { notation: "context-map" }), []);
  // an unregistered notation id has no mediaKind — nothing to gate
  assert.deepEqual(checkModelBaseline("anything", { notation: "no-such" }), []);
  // the xml branch — unreachable from runCli today (bpmn/dmn have full
  // checkers), but the first future xml notation ships on this gate
  assert.deepEqual(checkModelBaseline("<a/>", { notation: "bpmn" }), []);
  const xml = checkModelBaseline("<a", { file: "m.bpmn", notation: "bpmn" });
  assert.match(xml[0]?.message ?? "", /not well-formed XML/);
});

test("checkModelBaseline: every ```mermaid fence of a document names its type first", () => {
  const doc = (raw: string) => checkModelBaseline(raw, { file: "models/flow.md", notation: "markdown" });
  assert.deepEqual(doc("# Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```\n"), []);
  assert.deepEqual(doc(templateFor("markdown", "flow", "Flow") ?? ""), []);
  // the front matter, the directives and the comments come before it
  assert.deepEqual(doc('```mermaid\n---\ntitle: "Flow"\n---\n%%{init: {}}%%\n%% notes\nsequenceDiagram\n```\n'), []);
  // light on purpose: the grammar is the renderer's (mermaid needs a DOM),
  // so a broken body behind a valid header passes here; other fences and
  // the prose are not the check's
  assert.deepEqual(doc("```mermaid\nflowchart LR\n  A -->\n```\n\n```ts\nflowchrt\n```\nflowchrt\n"), []);

  // a WARN with the DOCUMENT's line: the line of the fence's first line
  // that names no type (front matter included), the fence's own when empty
  const findings = doc(
    [
      "# Flow", // 1
      "", // 2
      "```mermaid", // 3
      "---", // 4
      'title: "Flow"', // 5
      "---", // 6
      "flowchrt LR", // 7
      "```", // 8
      "", // 9
      "~~~ Mermaid", // 10
      "%% only a note", // 11
      "~~~", // 12
      "", // 13
      "- step", // 14
      "", // 15
      "  ```mermaid", // 16
      "  zenuml", // 17
      "  ```", // 18
    ].join("\n"),
  );
  assert.deepEqual(
    findings.map((f) => [f.severity, f.ruleId, f.file]),
    Array.from({ length: 3 }, () => ["WARN", "mermaid/diagram-type", "models/flow.md"]),
  );
  assert.match(
    findings[0]?.message ?? "",
    /^line 7: 'flowchrt' is not a Mermaid diagram type \(flowchart, sequenceDiagram/,
  );
  assert.match(findings[1]?.message ?? "", /^line 10: empty Mermaid diagram: the first line must name a diagram type/);
  // zenuml is a plugin mermaid does not bundle: it does not draw here either
  assert.match(findings[2]?.message ?? "", /^line 17: 'zenuml' is not a Mermaid diagram type/);
  // an unclosed fence is checked to the end of the document
  assert.match(doc("text\n```mermaid\n")[0]?.message ?? "", /^line 2: empty Mermaid diagram/);
  // a commented-out diagram is no fence, and the DSLs keep no header rule
  assert.deepEqual(doc("<!--\n```mermaid\nflowchrt\n```\n-->\n"), []);
  assert.deepEqual(checkModelBaseline("", { notation: "wardley" }), []);
});

test("a broken .tt fails the run; valid non-BPMN models are counted", () => {
  const dir = repoWith({ "teams.tt": "{ this is not json" });
  const { status, out } = run(["--root", dir]);
  assert.equal(status, 1);
  assert.match(out, /\[ERROR\] models\/teams\.tt: not parseable as JSON/);

  const ok = repoWith({ "teams.tt": "{}", "tea.owm": "component Tea [0.5, 0.5]" });
  const green = run(["--root", ok]);
  assert.equal(green.status, 0, green.out);
  assert.match(green.out, /2 other model\(s\) checked/);
});

test("a document with a broken diagram warns but passes the run; a standalone .mmd is no model", () => {
  const dir = repoWith({ "flow.md": "# Flow\n\n```mermaid\n```\n" });
  const { status, out } = run(["--root", dir]);
  assert.equal(status, 0, out);
  assert.match(out, /\[WARN\] models\/flow\.md: line 3: empty Mermaid diagram/);
  assert.match(out, /0 error\(s\), 1 warning\(s\) — OK \(0 process\(es\), 1 other model\(s\) checked\)/);

  // diagram files of their own (withdrawn in 5.5) are plain files: not
  // counted, not checked
  const plain = repoWith({ "flow.mmd": "", "states.mermaid": "flowchrt", "notes.md": "# Notes\n" });
  const green = run(["--root", plain]);
  assert.equal(green.status, 0, green.out);
  assert.doesNotMatch(green.out, /\.mmd|\.mermaid/);
  assert.match(green.out, /0 error\(s\), 0 warning\(s\) — OK \(0 process\(es\), 1 other model\(s\) checked\)/);
});

test("the single-model filter reaches non-BPMN models", () => {
  const dir = repoWith({ "supply.vc.json": "{ broken" });
  const { status, out } = run(["--root", dir, "supply"]);
  assert.equal(status, 1);
  assert.match(out, /not parseable as JSON/);
});
