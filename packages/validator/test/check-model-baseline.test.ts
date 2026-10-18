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

test("checkModelBaseline: a Mermaid diagram names its type on its first line", () => {
  const mermaid = (raw: string) => checkModelBaseline(raw, { file: "models/flow.mmd", notation: "mermaid" });
  assert.deepEqual(mermaid("flowchart LR\n  A --> B\n"), []);
  assert.deepEqual(mermaid(templateFor("mermaid", "flow", "Flow") ?? ""), []);
  // the front matter, the directives and the comments come before it
  assert.deepEqual(mermaid('---\ntitle: "Flow"\n---\n%%{init: {}}%%\n%% notes\nsequenceDiagram\n  A->>B: hi\n'), []);
  // light on purpose: the grammar is the renderer's (mermaid needs a DOM),
  // so a broken body behind a valid header passes here
  assert.deepEqual(mermaid("flowchart LR\n  A -->\n"), []);

  // a WARN: a .mmd snippet a content repo already keeps never fails its CI
  for (const empty of ["", "  \n\n", "%% only a note\n", '---\ntitle: "Flow"\n---\n']) {
    const findings = mermaid(empty);
    assert.equal(findings.length, 1, JSON.stringify(empty));
    assert.equal(findings[0]?.severity, "WARN");
    assert.equal(findings[0]?.ruleId, "mermaid/diagram-type");
    assert.equal(findings[0]?.file, "models/flow.mmd");
    assert.match(findings[0]?.message ?? "", /^empty Mermaid diagram: the first line must name a diagram type/);
  }
  // the line is the SOURCE line, front matter included
  const typo = mermaid('---\ntitle: "Flow"\n---\nflowchrt LR\n  A --> B\n');
  assert.equal(typo.length, 1);
  assert.equal(typo[0]?.severity, "WARN");
  assert.match(
    typo[0]?.message ?? "",
    /^line 4: 'flowchrt' is not a Mermaid diagram type \(flowchart, sequenceDiagram/,
  );
  // zenuml is a plugin mermaid does not bundle: it does not draw here either
  assert.match(mermaid("zenuml\n  A.method()\n")[0]?.message ?? "", /'zenuml' is not a Mermaid diagram type/);
  // the other DSLs keep no header rule
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

test("an empty Mermaid diagram warns but passes the run; one under either extension is counted", () => {
  const dir = repoWith({ "flow.mmd": "" });
  const { status, out } = run(["--root", dir]);
  assert.equal(status, 0, out);
  assert.match(out, /\[WARN\] models\/flow\.mmd: empty Mermaid diagram/);

  const ok = repoWith({ "flow.mmd": "flowchart LR\n  A --> B\n", "states.mermaid": "stateDiagram-v2\n  [*] --> A\n" });
  const green = run(["--root", ok]);
  assert.equal(green.status, 0, green.out);
  assert.match(green.out, /2 other model\(s\) checked/);
});

test("the single-model filter reaches non-BPMN models", () => {
  const dir = repoWith({ "supply.vc.json": "{ broken" });
  const { status, out } = run(["--root", dir, "supply"]);
  assert.equal(status, 1);
  assert.match(out, /not parseable as JSON/);
});
