/**
 * A boot that a gate refuses still prints the startup report's warnings (#2):
 * the upgrade that keeps the retired GITHUB_CLIENT_* is the one the oidc gate
 * stops, and it is the operator of that upgrade who needs the hint.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts");
const OAUTH_SECRET = "oauth-secret-must-not-leak";

test("the oidc gate refuses the boot after the warnings, and no secret value is printed", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "live-host-boot-refusal-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const boot = spawnSync(process.execPath, [SERVER], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      LIVE_DATA_DIR: dataDir,
      PORT: "0",
      LIVE_AUTH: "oidc",
      // empty instead of unset: a developer's apps/live-host/.env never fills in what is already set
      LIVE_OIDC_ISSUER: "",
      LIVE_OIDC_JWKS_URL: "",
      LIVE_OIDC_CLIENT_ID: "",
      GITHUB_CLIENT_ID: "Iv1.old",
      GITHUB_CLIENT_SECRET: OAUTH_SECRET,
    },
  });
  assert.equal(boot.status, 1, `the boot was not refused:\n${boot.stdout}\n${boot.stderr}`);
  assert.match(boot.stderr, /LIVE_AUTH=oidc needs LIVE_OIDC_ISSUER \+ LIVE_OIDC_JWKS_URL \+ LIVE_OIDC_CLIENT_ID/);
  assert.ok(
    boot.stdout
      .split("\n")
      .includes(
        "warning   : GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are no longer read (ADR 0007 retired the GitHub " +
          "OAuth login): remove them, the login is LIVE_OIDC_*",
      ),
    `no retired-variable warning before the refusal:\n${boot.stdout}`,
  );
  assert.ok(!`${boot.stdout}${boot.stderr}`.includes(OAUTH_SECRET), "a secret value was printed");
});
