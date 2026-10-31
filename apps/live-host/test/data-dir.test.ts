/**
 * The data directory's boot check (src/data-dir.ts, #3) against real directories made
 * unwritable with chmod, and server.ts refusing to boot on one. Root writes through any
 * mode bit, so these skip when the tests run as root.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { dataDirProblem } from "../src/data-dir.ts";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts");
const skip = process.getuid?.() === 0 ? "root writes through any mode bit" : false;
const IDS = { uid: 1000, gid: 1000 };
const self = `${process.getuid?.()}:${process.getgid?.()}`;

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "designiq-data-dir-"));
  t.after(() => {
    for (const path of [dir, join(dir, "data"), join(dir, "workspaces")]) {
      if (existsSync(path)) chmodSync(path, 0o755);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test(
  "a writable data directory passes, also before it exists and once it holds live.db and the clones",
  { skip },
  (t) => {
    const dir = scratch(t);
    assert.equal(dataDirProblem(join(dir, "data", "nested"), IDS), undefined);
    writeFileSync(join(dir, "live.db"), "");
    mkdirSync(join(dir, "workspaces"));
    assert.equal(dataDirProblem(dir, IDS), undefined);
  },
);

test(
  "an unwritable data directory names itself, its owner, the uid:gid the host runs as and the chown",
  { skip },
  (t) => {
    const dir = scratch(t);
    chmodSync(dir, 0o555);
    const message = dataDirProblem(dir, IDS) ?? "";
    assert.match(message, /^designIQ cannot write its data directory /);
    assert.ok(
      message.includes(`${dir}: ${dir} belongs to ${self}, and the Live Host runs as 1000:1000 (uid:gid).`),
      message,
    );
    assert.ok(message.includes(`\n  chown -R 1000:1000 ${dir}\n`), message);
    assert.ok(message.includes(`docker compose run --rm --user root live-host chown -R 1000:1000 ${dir}`), message);
    // the root-owned explanation is for root-owned paths only
    assert.ok(!message.includes("ran as root"), message);
  },
);

for (const entry of ["live.db", "workspaces"]) {
  test(`an unwritable ${entry} in a writable data directory is named`, { skip }, (t) => {
    const dir = scratch(t);
    const path = join(dir, entry);
    if (entry === "workspaces") mkdirSync(path, { mode: 0o555 });
    else writeFileSync(path, "", { mode: 0o444 });
    const message = dataDirProblem(dir, IDS) ?? "";
    assert.ok(message.includes(`${dir}: ${path} belongs to ${self}`), message);
    assert.ok(message.includes(`chown -R 1000:1000 ${dir}`), message);
  });
}

test("a data directory its parent does not let the host create names the parent and the mkdir", { skip }, (t) => {
  const dir = scratch(t);
  chmodSync(dir, 0o555);
  const dataDir = join(dir, "data");
  const message = dataDirProblem(dataDir, IDS) ?? "";
  assert.ok(message.includes(`cannot create its data directory ${dataDir}: ${dir} belongs to ${self}`), message);
  assert.ok(message.includes(`mkdir -p ${dataDir} && chown -R 1000:1000 ${dataDir}`), message);
});

test(
  "server.ts stops at boot on an unwritable data directory, with the fix, before it opens live.db",
  { skip },
  async (t) => {
    const dir = scratch(t);
    chmodSync(dir, 0o555);
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, LIVE_DATA_DIR: dir, LIVE_AUTH: "none", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const code = await new Promise<number | null>((done) => child.on("close", done));
    clearTimeout(timer);
    assert.equal(code, 1, stderr);
    assert.ok(stderr.includes(`designIQ cannot write its data directory ${dir}`), stderr);
    assert.ok(stderr.includes(`chown -R ${self} ${dir}`), stderr);
    assert.equal(existsSync(join(dir, "live.db")), false);
  },
);
