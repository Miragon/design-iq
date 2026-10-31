/**
 * The live-host image runs unprivileged (#3). Its runtime stage ends on a numeric USER,
 * the only kind Kubernetes' runAsNonRoot can verify, and hands /data to that uid:gid,
 * so a fresh named volume, which takes its owner from the image, is writable. git trusts
 * every checkout, since a bind mount or an older image's clones can belong to another uid.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dockerfile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "Dockerfile"), "utf8");
const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

test("the runtime stage runs as a numeric non-root uid:gid, after its last RUN", () => {
  const users = [...runtimeStage.matchAll(/^USER\s+(.+?)\s*$/gm)].map((match) => match[1]);
  assert.equal(users.length, 1, `one USER in the runtime stage, found ${users.length}`);
  assert.match(users[0] ?? "", /^[1-9]\d*:\d+$/);
  assert.ok(runtimeStage.lastIndexOf("\nUSER ") > runtimeStage.lastIndexOf("\nRUN "));
});

test("the runtime stage hands /data to the uid:gid it runs as", () => {
  const user = /^USER\s+(\S+)/m.exec(runtimeStage)?.[1] ?? "<no USER>";
  assert.ok(runtimeStage.includes(`chown ${user} /data`), `chown ${user} /data`);
  assert.match(runtimeStage, /^ENV .*LIVE_DATA_DIR=\/data/m);
});

test("the runtime stage lets git work in checkouts that are not its user's", () => {
  const trust = runtimeStage.indexOf("\nRUN git config --system --add safe.directory '*'\n");
  assert.ok(trust > 0, "git config --system --add safe.directory '*' in the runtime stage");
  assert.ok(trust < runtimeStage.lastIndexOf("\nUSER "), "set as root, before USER");
});
