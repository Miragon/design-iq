/**
 * The startup banner (#2): one test per operating mode, one per half-configured
 * setting the report knows, and one that no secret value reaches the log.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { startupReport, type StartupSettings, startupWarningLines } from "../src/domain/startup-report.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretpemkeymaterial\n-----END RSA PRIVATE KEY-----";

function settings(overrides: Partial<StartupSettings> = {}): StartupSettings {
  return {
    port: 8301,
    hostRepo: "acme/processes",
    hostContentDir: "/srv/content",
    dataDir: "/data",
    repos: ["acme/processes"],
    enumeratesInstallations: false,
    auth: "none",
    localUser: "petra",
    githubApp: {},
    oidc: {},
    cell: {},
    retiredGitHubOAuth: {},
    mcp: { readOnly: false, bpmnEdit: false },
    ...overrides,
  };
}

const fullApp = { id: "4711", privateKey: PEM, slug: "designiq-acme", webhookSecret: "whsec-1" };
const fullOidc = {
  issuer: "https://idp.example.com/realms/designiq",
  jwksUrl: "https://idp.example.com/realms/designiq/certs",
  clientId: "designiq-web",
};
const recommended = (overrides: Partial<StartupSettings> = {}): StartupSettings =>
  settings({
    auth: "oidc",
    localUser: undefined,
    githubApp: fullApp,
    oidc: fullOidc,
    sessionKey: "session-key-1",
    enumeratesInstallations: true,
    ...overrides,
  });

function line(lines: readonly string[], label: string): string | undefined {
  return lines.find((l) => l.startsWith(`${label.padEnd(10)}: `));
}

test("no auth without an App: single-repo mode, and the next mode names every missing setting", () => {
  const report = startupReport(settings());
  assert.equal(report.mode, "no-auth-single-repo");
  assert.equal(line(report.lines, "mode"), "mode      : no auth (LIVE_AUTH=none), single repo (acme/processes)");
  assert.equal(
    line(report.lines, "next mode"),
    "next mode : OIDC + GitHub App, missing GITHUB_APP_ID, an app private key (GITHUB_APP_PRIVATE_KEY, " +
      "GITHUB_APP_PRIVATE_KEY_FILE or GITHUB_APP_PRIVATE_KEY_B64), LIVE_OIDC_ISSUER, LIVE_OIDC_JWKS_URL and " +
      "LIVE_OIDC_CLIENT_ID; then set LIVE_AUTH=oidc",
  );
  assert.match(line(report.lines, "repos") ?? "", /static: no connection source/);
  assert.match(line(report.lines, "auth") ?? "", /NONE \(LIVE_AUTH=none\): every request is @petra/);
  assert.deepEqual(report.warnings, []);
});

test("no auth with an App: the next mode up needs only the OIDC login", () => {
  const report = startupReport(settings({ githubApp: fullApp, enumeratesInstallations: true }));
  assert.equal(report.mode, "no-auth-github-app");
  assert.equal(line(report.lines, "mode"), "mode      : no auth (LIVE_AUTH=none), GitHub App");
  assert.equal(
    line(report.lines, "next mode"),
    "next mode : OIDC + GitHub App, missing LIVE_OIDC_ISSUER, LIVE_OIDC_JWKS_URL and LIVE_OIDC_CLIENT_ID; then set LIVE_AUTH=oidc",
  );
  assert.equal(line(report.lines, "minting"), "minting   : local (app key)");
  assert.deepEqual(report.warnings, []);
});

test("OIDC + GitHub App is the top on-prem mode: no next mode, no warning", () => {
  const report = startupReport(recommended());
  assert.equal(report.mode, "oidc-github-app");
  assert.equal(line(report.lines, "mode"), "mode      : OIDC + GitHub App");
  assert.equal(line(report.lines, "next mode"), undefined);
  assert.equal(
    line(report.lines, "auth"),
    "auth      : OIDC, browser SSO + bearer JWT (https://idp.example.com/realms/designiq)",
  );
  assert.deepEqual(report.warnings, []);
});

test("a tenant installation id is cell mode, with the control plane's minting and no App slug needed", () => {
  const report = startupReport(
    recommended({
      githubApp: {},
      cell: { tenantInstallationId: 42, tokenMintUrl: "https://control.example.com/mint", cellSecret: "cell-1" },
    }),
  );
  assert.equal(report.mode, "cell");
  assert.equal(line(report.lines, "mode"), "mode      : cell (installation 42)");
  assert.equal(line(report.lines, "next mode"), undefined);
  assert.equal(line(report.lines, "minting"), "minting   : remote (control plane, tenant 42)");
  assert.deepEqual(report.warnings, []);
});

test("a cell that mints remotely is not asked for the App's own key, webhook secret or slug", () => {
  const remoteMinting = {
    tenantInstallationId: 42,
    tokenMintUrl: "https://control.example.com/mint",
    cellSecret: "cell-1",
  };
  for (const githubApp of [{ id: "4711" }, { id: "4711", privateKey: PEM }]) {
    const report = startupReport(recommended({ githubApp, cell: remoteMinting }));
    assert.equal(report.mode, "cell");
    assert.equal(line(report.lines, "minting"), "minting   : remote (control plane, tenant 42)");
    assert.deepEqual(report.warnings, [], `GITHUB_APP_ID${githubApp.privateKey ? " + key" : ""} in a cell`);
  }
});

test("GITHUB_APP_ID without a private key: the App connection stays off, named with the key variables", () => {
  const report = startupReport(settings({ githubApp: { id: "4711" } }));
  assert.equal(report.mode, "no-auth-single-repo");
  assert.deepEqual(report.warnings, [
    "GITHUB_APP_ID is set but no app private key was found (GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_FILE " +
      "or GITHUB_APP_PRIVATE_KEY_B64): the GitHub App connection stays off",
  ]);
  assert.ok(report.lines.includes(`warning   : ${report.warnings[0]}`));
  assert.doesNotMatch(line(report.lines, "next mode") ?? "", /GITHUB_APP_ID/, "the id is set, only the key is missing");
});

test("a private key without GITHUB_APP_ID: the App connection stays off", () => {
  const report = startupReport(settings({ githubApp: { privateKey: PEM } }));
  assert.equal(report.mode, "no-auth-single-repo");
  assert.deepEqual(report.warnings, [
    "an app private key was found but GITHUB_APP_ID is missing: the GitHub App connection stays off",
  ]);
});

test("an App without GITHUB_WEBHOOK_SECRET: webhooks are refused", () => {
  const report = startupReport(recommended({ githubApp: { ...fullApp, webhookSecret: undefined } }));
  assert.deepEqual(report.warnings, [
    "GITHUB_WEBHOOK_SECRET is missing: POST /webhook/github answers 503, so installation changes show up only after Refresh or a restart",
  ]);
});

test("an App without GITHUB_APP_SLUG: users cannot add repositories", () => {
  const report = startupReport(recommended({ githubApp: { ...fullApp, slug: undefined } }));
  assert.deepEqual(report.warnings, [
    'GITHUB_APP_SLUG is missing: the overview shows no "Add repository" button, so users cannot connect repositories',
  ]);
});

test("LIVE_AUTH=none names the LIVE_OIDC_* settings it ignores", () => {
  const report = startupReport(settings({ oidc: { issuer: fullOidc.issuer, clientId: fullOidc.clientId } }));
  assert.deepEqual(report.warnings, [
    "LIVE_OIDC_ISSUER and LIVE_OIDC_CLIENT_ID are set but LIVE_AUTH=none ignores them: an unauthenticated host has no login",
  ]);
  assert.match(line(report.lines, "next mode") ?? "", /missing GITHUB_APP_ID, .*LIVE_OIDC_JWKS_URL; then/);
  assert.deepEqual(
    startupReport(
      settings({
        oidc: {
          audience: "https://designiq.example.com",
          loginClaim: "preferred_username",
          clientSecret: "oidc-secret",
          loginLabel: "Acme SSO",
        },
      }),
    ).warnings,
    [
      "LIVE_OIDC_AUDIENCE, LIVE_OIDC_LOGIN_CLAIM, LIVE_OIDC_CLIENT_SECRET and LIVE_OIDC_LOGIN_LABEL are set but " +
        "LIVE_AUTH=none ignores them: an unauthenticated host has no login",
    ],
    "the variables beyond the IdP pair and the client id count too",
  );
});

test("the retired GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET pair is named, either half alone too", () => {
  assert.deepEqual(startupReport(recommended({ retiredGitHubOAuth: { clientId: "Iv1.abc" } })).warnings, [
    "GITHUB_CLIENT_ID is no longer read (ADR 0007 retired the GitHub OAuth login): remove it, the login is LIVE_OIDC_*",
  ]);
  assert.deepEqual(
    startupReport(settings({ retiredGitHubOAuth: { clientId: "Iv1.abc", clientSecret: "oauth-secret" } })).warnings,
    [
      "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are no longer read (ADR 0007 retired the GitHub OAuth login): remove them, the login is LIVE_OIDC_*",
    ],
  );
});

test("one OIDC endpoint override without the other: discovery still runs for the missing one", () => {
  assert.deepEqual(
    startupReport(recommended({ oidc: { ...fullOidc, authorizeUrl: "https://idp.example.com/auth" } })).warnings,
    [
      "LIVE_OIDC_AUTHORIZE_URL is set but LIVE_OIDC_TOKEN_URL is missing: the token endpoint still comes from OIDC " +
        "discovery at https://idp.example.com/realms/designiq/.well-known/openid-configuration",
    ],
  );
  assert.deepEqual(
    startupReport(recommended({ oidc: { ...fullOidc, tokenUrl: "https://idp.example.com/token" } })).warnings,
    [
      "LIVE_OIDC_TOKEN_URL is set but LIVE_OIDC_AUTHORIZE_URL is missing: the authorize endpoint still comes from " +
        "OIDC discovery at https://idp.example.com/realms/designiq/.well-known/openid-configuration",
    ],
  );
});

test("the discovery URL in that warning is the one the login fetches, also for an issuer ending in a slash", () => {
  assert.deepEqual(
    startupReport(
      recommended({
        oidc: { ...fullOidc, issuer: "https://acme.eu.auth0.com/", tokenUrl: "https://acme.eu.auth0.com/oauth/token" },
      }),
    ).warnings,
    [
      "LIVE_OIDC_TOKEN_URL is set but LIVE_OIDC_AUTHORIZE_URL is missing: the authorize endpoint still comes from " +
        "OIDC discovery at https://acme.eu.auth0.com/.well-known/openid-configuration",
    ],
  );
  assert.deepEqual(
    startupWarningLines({ ...recommended(), oidc: { tokenUrl: "https://idp.example.com/token" } }),
    [
      "warning   : LIVE_OIDC_TOKEN_URL is set but LIVE_OIDC_AUTHORIZE_URL is missing: the authorize endpoint still " +
        "comes from OIDC discovery",
    ],
    "a boot refused for a missing issuer names no discovery URL",
  );
});

test("OIDC without SESSION_ENC_KEY: logins in flight break on a restart", () => {
  assert.deepEqual(startupReport(recommended({ sessionKey: undefined })).warnings, [
    "SESSION_ENC_KEY is not set: the login state key is random per boot, so a restart or redeploy breaks the logins in flight",
  ]);
  assert.deepEqual(
    startupReport(settings({ sessionKey: undefined })).warnings,
    [],
    "a host without a login has no login state to keep",
  );
});

test("CELL_SECRET without TOKEN_MINT_URL: remote minting stays off", () => {
  const report = startupReport(settings({ githubApp: fullApp, cell: { cellSecret: "cell-1" } }));
  assert.equal(report.mode, "no-auth-github-app");
  assert.equal(line(report.lines, "minting"), "minting   : local (app key)");
  assert.deepEqual(report.warnings, [
    "CELL_SECRET is set but TOKEN_MINT_URL is missing: remote token minting stays off",
  ]);
});

test("TENANT_INSTALLATION_ID without any token source: no repository is served", () => {
  const report = startupReport(settings({ repos: [], cell: { tenantInstallationId: 42 } }));
  assert.equal(report.mode, "cell");
  assert.deepEqual(report.warnings, [
    "TENANT_INSTALLATION_ID is set but no installation token can be minted (TOKEN_MINT_URL + CELL_SECRET, or " +
      "GITHUB_APP_ID + an app private key): no repository is served",
  ]);
});

test("a boot the oidc gate refuses gets the banner's warning lines, without the served repositories", () => {
  const { auth, githubApp, oidc, sessionKey, cell, retiredGitHubOAuth } = settings({
    auth: "oidc",
    githubApp: { id: "4711" },
    retiredGitHubOAuth: { clientId: "Iv1.old", clientSecret: "oauth-secret" },
  });
  assert.deepEqual(startupWarningLines({ auth, githubApp, oidc, sessionKey, cell, retiredGitHubOAuth }), [
    "warning   : GITHUB_APP_ID is set but no app private key was found (GITHUB_APP_PRIVATE_KEY, " +
      "GITHUB_APP_PRIVATE_KEY_FILE or GITHUB_APP_PRIVATE_KEY_B64): the GitHub App connection stays off",
    "warning   : SESSION_ENC_KEY is not set: the login state key is random per boot, so a restart or redeploy " +
      "breaks the logins in flight",
    "warning   : GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are no longer read (ADR 0007 retired the GitHub OAuth " +
      "login): remove them, the login is LIVE_OIDC_*",
  ]);
});

test("no secret value reaches the banner, in any mode or half-configured state", () => {
  const secrets = {
    privateKey: PEM,
    webhookSecret: "whsec-must-not-leak",
    sessionKey: "session-key-must-not-leak",
    cellSecret: "cell-secret-must-not-leak",
    oauthSecret: "oauth-secret-must-not-leak",
    oidcClientSecret: "oidc-client-secret-must-not-leak",
  };
  const variants: StartupSettings[] = [
    settings({
      githubApp: { privateKey: secrets.privateKey },
      cell: { cellSecret: secrets.cellSecret },
      retiredGitHubOAuth: { clientSecret: secrets.oauthSecret },
    }),
    settings({
      githubApp: { ...fullApp, privateKey: secrets.privateKey, webhookSecret: secrets.webhookSecret },
      oidc: { clientSecret: secrets.oidcClientSecret },
    }),
    recommended({
      githubApp: { ...fullApp, privateKey: secrets.privateKey, webhookSecret: secrets.webhookSecret },
      oidc: { ...fullOidc, clientSecret: secrets.oidcClientSecret, tokenUrl: "https://idp.example.com/token" },
      sessionKey: secrets.sessionKey,
      retiredGitHubOAuth: { clientSecret: secrets.oauthSecret },
    }),
    recommended({
      githubApp: { privateKey: secrets.privateKey },
      sessionKey: secrets.sessionKey,
      cell: {
        tenantInstallationId: 42,
        tokenMintUrl: "https://control.example.com/mint",
        cellSecret: secrets.cellSecret,
      },
    }),
  ];
  for (const variant of variants) {
    const banner = [...startupReport(variant).lines, ...startupWarningLines(variant)].join("\n");
    for (const value of [...Object.values(secrets), "MIIEsecretpemkeymaterial"]) {
      assert.ok(!banner.includes(value), `the banner holds a secret value:\n${banner}`);
    }
  }
});
