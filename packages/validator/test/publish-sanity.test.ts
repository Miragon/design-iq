/**
 * publish-npm.yml must refuse to publish a validator whose bin does not work (#282). Its sanity
 * step once ran dist/validate.js, the library entry, which never calls runCli(): it printed
 * nothing and passed whatever dist/cli.js held. Run in the workspace through `node`, a bin without
 * a shebang or one importing a workspace-only package passes too, yet breaks once npm installs
 * it. These tests run that step as the workflow does, in a checkout whose packages/validator/dist
 * is a real build or a broken one.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { parse } from "yaml";

const PACKAGE = resolve(import.meta.dirname, "..");
const REPO = resolve(PACKAGE, "../..");

interface Step {
  if?: string;
  run?: string;
  shell?: string;
}
interface Workflow {
  defaults?: { run?: { shell?: string } };
  jobs: { publish: { defaults?: { run?: { shell?: string } }; steps: Step[] } };
}

const workflow = parse(readFileSync(join(REPO, ".github/workflows/publish-npm.yml"), "utf8")) as Workflow;
const validatorSteps = workflow.jobs.publish.steps.filter(
  (step) => step.if === "inputs.package == 'validator'" && step.run !== undefined,
);

// Actions runs a step without `shell:` as `bash -e`, without pipefail: a test that adds pipefail
// would pass a step that fails in CI.
function bashArguments(step: Step): string[] {
  const shell = step.shell ?? workflow.jobs.publish.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
  if (shell === undefined) return ["-e"];
  if (shell === "bash") return ["--noprofile", "--norc", "-eo", "pipefail"];
  throw new Error(`publish-npm.yml: the validator step runs in '${shell}', which this test does not emulate`);
}

let scratch = "";
let realBuild = "";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "designiq-publish-sanity-"));
  realBuild = join(scratch, "dist");
  const build = spawnSync(join(PACKAGE, "node_modules/.bin/tsdown"), ["--out-dir", realBuild, "--log-level", "error"], {
    cwd: PACKAGE,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

// Everything but packages/validator/dist links back to this checkout, so the step reads the same
// example content, fixtures and package.json it reads in CI, whatever paths it names. pnpm pack
// leaves symlinked files out of the tarball, so the validator's package.json is a copy.
function checkoutWith(dist: string): string {
  const root = mkdtempSync(join(scratch, "checkout-"));
  const linkAllExcept = (from: string, to: string, except: string[]): void => {
    for (const entry of readdirSync(from)) if (!except.includes(entry)) symlinkSync(join(from, entry), join(to, entry));
  };
  linkAllExcept(REPO, root, ["packages"]);
  mkdirSync(join(root, "packages"));
  linkAllExcept(join(REPO, "packages"), join(root, "packages"), ["validator"]);
  mkdirSync(join(root, "packages/validator"));
  linkAllExcept(PACKAGE, join(root, "packages/validator"), ["dist", "package.json"]);
  cpSync(join(PACKAGE, "package.json"), join(root, "packages/validator/package.json"));
  cpSync(dist, join(root, "packages/validator/dist"), { recursive: true });
  return root;
}

function buildWithBin(cli: string): string {
  const dist = mkdtempSync(join(scratch, "broken-dist-"));
  cpSync(realBuild, dist, { recursive: true });
  cpSync(join(dist, "cli.js"), join(dist, "real-cli.js"));
  writeFileSync(join(dist, "cli.js"), cli);
  return dist;
}

function runValidatorSteps(dist: string): { status: number | null; output: string } {
  const cwd = checkoutWith(dist);
  const output: string[] = [];
  for (const [index, step] of validatorSteps.entries()) {
    const script = join(cwd, `.step-${index}.sh`);
    writeFileSync(script, step.run!);
    const run = spawnSync("bash", [...bashArguments(step), script], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
    });
    output.push(run.stdout, run.stderr);
    if (run.status !== 0) return { status: run.status, output: output.join("") };
  }
  return { status: 0, output: output.join("") };
}

const SHEBANG = "#!/usr/bin/env node\n";

const RUN_REAL_CLI = `${SHEBANG}import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const run = spawnSync(process.execPath, [fileURLToPath(new URL("./real-cli.js", import.meta.url)), ...process.argv.slice(2)], { encoding: "utf8" });
`;

// One broken bin per check of the step, so no check can go dead unnoticed, and one per way a bin
// works in the workspace but not once npm installs it.
const BROKEN_BINS: { bin: string; source: () => string; error: RegExp }[] = [
  {
    bin: "is the library entry (prints nothing, exits 0)",
    source: () => `${SHEBANG}${readFileSync(join(realBuild, "validate.js"), "utf8")}`,
    error: /printed no OK summary for the example content repo/,
  },
  {
    bin: "imports a dependency that is not installed",
    source: () => `${SHEBANG}import "designiq-left-out-dependency";\n`,
    error: /exited 1 on the example content repo, expected 0/,
  },
  {
    bin: "lacks the shebang npm starts it through",
    source: () => readFileSync(join(realBuild, "cli.js"), "utf8").replace(/^#!.*\n/, ""),
    error: /exited \d+ on the example content repo, expected 0/,
  },
  {
    bin: "imports the workspace-only @designiq/notations",
    source: () =>
      readFileSync(join(realBuild, "cli.js"), "utf8").replace(/^#!.*\n/, `$&import "@designiq/notations";\n`),
    error: /exited 1 on the example content repo, expected 0/,
  },
  {
    bin: "exits 0 although the model is invalid",
    source: () => `${RUN_REAL_CLI}process.stdout.write(run.stdout);\n`,
    error: /exited 0 on \S+invalid-content-repo, expected 1/,
  },
  {
    bin: "crashes on the invalid model instead of reporting it",
    source: () =>
      `${RUN_REAL_CLI}if (run.status !== 0) throw new Error("crashed");\nprocess.stdout.write(run.stdout);\n`,
    error: /did not report the invalid model of \S+invalid-content-repo/,
  },
];

test("publish-npm.yml has one sanity step for the validator", () => {
  assert.equal(validatorSteps.length, 1, "expected exactly one `run` step with if: inputs.package == 'validator'");
});

test("the real build passes the step: the example content repo validates, the invalid model fails", () => {
  const { status, output } = runValidatorSteps(realBuild);
  assert.equal(status, 0, output);
  assert.match(output, /^0 error\(s\), \d+ warning\(s\) .+ OK \(\d+ process\(es\)/m);
  assert.match(output, /^\[ERROR\] processes\/ship-order\.bpmn: Task_ship has no BPMNDI shape/m);
  assert.match(output, /^1 error\(s\), \d+ warning\(s\) .+ FAIL \(1 process\(es\) checked\)$/m);
});

for (const { bin, source, error } of BROKEN_BINS) {
  test(`a bin that ${bin} fails the step`, () => {
    const { status, output } = runValidatorSteps(buildWithBin(source()));
    assert.notEqual(status, 0, output);
    assert.match(output, new RegExp(`::error::designiq-validate ${error.source}`));
  });
}
