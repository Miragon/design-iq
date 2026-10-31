/**
 * The startup banner (#2): the operating mode the environment selects, what the
 * next mode up still needs, and each half-configured setting with what stays off
 * because of it. A misconfiguration used to surface on first use (a webhook
 * answering 503, a missing "Add repository" button); the banner names it at boot.
 *
 * Pure: server.ts reads the env and hands over what it parsed. Secret values
 * come in only to be tested for presence; the report says whether one is set,
 * never what it is, because boot logs end up in log aggregators.
 */

/** the mode names of docs/on-prem (README "Operating modes", configuration.md) */
export type OperatingMode = "no-auth-single-repo" | "no-auth-github-app" | "oidc-github-app" | "cell";

export interface StartupSettings {
  port: number;
  hostRepo: string;
  hostContentDir: string;
  dataDir: string;
  /** the repositories the registry serves once the boot sync is done */
  repos: readonly string[];
  enumeratesInstallations: boolean;
  auth: "oidc" | "none";
  /** the local principal's login under LIVE_AUTH=none */
  localUser?: string;
  githubApp: { id?: string; privateKey?: string; slug?: string; webhookSecret?: string };
  oidc: {
    issuer?: string;
    jwksUrl?: string;
    audience?: string;
    loginClaim?: string;
    clientId?: string;
    clientSecret?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    loginLabel?: string;
  };
  /** SESSION_ENC_KEY, else CELL_TOKEN_KEY */
  sessionKey?: string;
  cell: { tenantInstallationId?: number; tokenMintUrl?: string; cellSecret?: string };
  retiredGitHubOAuth: { clientId?: string; clientSecret?: string };
  mcp: { readOnly: boolean; bpmnEdit: boolean };
}

/**
 * What the half-configured check reads. All of it is parsed before the boot
 * gates, unlike the repositories the boot sync finds, so a refused boot can
 * name its warnings too.
 */
export type StartupConfiguration = Pick<
  StartupSettings,
  "auth" | "githubApp" | "oidc" | "sessionKey" | "cell" | "retiredGitHubOAuth"
>;

export interface StartupReport {
  mode: OperatingMode;
  warnings: string[];
  /** the banner, one console line each */
  lines: string[];
}

const RULE = "─".repeat(50);
const PRIVATE_KEY_VARIABLES = "GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_FILE or GITHUB_APP_PRIVATE_KEY_B64";

export function startupReport(settings: StartupSettings): StartupReport {
  const localApp = hasLocalApp(settings);
  const mode = operatingMode(settings, localApp);
  const next = mode === "no-auth-single-repo" || mode === "no-auth-github-app" ? nextModeUp(settings) : undefined;
  const warnings = halfConfigured(settings);
  const { cell, mcp } = settings;
  const lines = [
    RULE,
    "Live Host ready (single port)",
    `mode      : ${modeLabel(mode, settings)}`,
    ...(next ? [`next mode : ${next}`] : []),
    `host repo : ${settings.hostRepo} (local content: ${settings.hostContentDir})`,
    `data dir  : ${settings.dataDir}`,
    `endpoint  : http://localhost:${settings.port}  (HTTP + WebSocket, one port)`,
    `repos     : ${settings.repos.join(", ")}${
      settings.enumeratesInstallations ? "" : "  (static: no connection source, installations not enumerated)"
    }`,
    `minting   : ${
      cell.tokenMintUrl
        ? `remote (control plane, tenant ${cell.tenantInstallationId})`
        : localApp
          ? "local (app key)"
          : "none"
    }`,
    settings.auth === "none"
      ? `auth      : NONE (LIVE_AUTH=none): every request is @${settings.localUser}, every repository writable; local evaluation or a trusted network only`
      : `auth      : OIDC, browser SSO + bearer JWT (${settings.oidc.issuer})`,
    `mcp       : POST /mcp${mcp.readOnly ? " (read-only: write tools not registered)" : ""}`,
    ...(mcp.bpmnEdit
      ? [
          `mcp       : + semantic BPMN tools (LIVE_MCP_BPMN_EDIT=1, ADR 0009)${mcp.readOnly ? ", read-only: the outline only" : ""}`,
        ]
      : []),
    `room name = <owner>/<repo>/<path>, Y.Text field 'content'`,
    ...warnings.map(warningLine),
    RULE,
  ];
  return { mode, warnings, lines };
}

/** the banner's warning lines alone, for a boot a gate refuses before the banner */
export function startupWarningLines(configuration: StartupConfiguration): string[] {
  return halfConfigured(configuration).map(warningLine);
}

function warningLine(warning: string): string {
  return `warning   : ${warning}`;
}

function hasLocalApp({ githubApp: app }: StartupConfiguration): boolean {
  return Boolean(app.id && app.privateKey);
}

function operatingMode(settings: StartupSettings, localApp: boolean): OperatingMode {
  if (settings.cell.tenantInstallationId !== undefined) return "cell";
  if (settings.auth === "oidc") return "oidc-github-app";
  return localApp ? "no-auth-github-app" : "no-auth-single-repo";
}

function modeLabel(mode: OperatingMode, settings: StartupSettings): string {
  switch (mode) {
    case "no-auth-single-repo":
      return `no auth (LIVE_AUTH=none), single repo (${settings.hostRepo})`;
    case "no-auth-github-app":
      return "no auth (LIVE_AUTH=none), GitHub App";
    case "oidc-github-app":
      return "OIDC + GitHub App";
    case "cell":
      return `cell (installation ${settings.cell.tenantInstallationId})`;
  }
}

/** the recommended on-prem mode, the only one above both no-auth modes */
function nextModeUp(settings: StartupSettings): string {
  const { githubApp: app, oidc } = settings;
  const missing = [
    app.id ? undefined : "GITHUB_APP_ID",
    app.privateKey ? undefined : `an app private key (${PRIVATE_KEY_VARIABLES})`,
    oidc.issuer ? undefined : "LIVE_OIDC_ISSUER",
    oidc.jwksUrl ? undefined : "LIVE_OIDC_JWKS_URL",
    oidc.clientId ? undefined : "LIVE_OIDC_CLIENT_ID",
  ].filter((setting) => setting !== undefined);
  return missing.length
    ? `OIDC + GitHub App, missing ${listed(missing)}; then set LIVE_AUTH=oidc`
    : "OIDC + GitHub App, every setting is in place; set LIVE_AUTH=oidc";
}

function halfConfigured(configuration: StartupConfiguration): string[] {
  const { githubApp: app, oidc, cell, retiredGitHubOAuth: retired } = configuration;
  const remoteMinting = Boolean(cell.tokenMintUrl && cell.cellSecret);
  const localApp = hasLocalApp(configuration);
  const warnings: string[] = [];
  // a cell gets its tokens and its webhooks from the control plane: the App's
  // own key, webhook secret and slug are an on-prem concern
  if (!remoteMinting) {
    if (app.id && !app.privateKey) {
      warnings.push(
        `GITHUB_APP_ID is set but no app private key was found (${PRIVATE_KEY_VARIABLES}): the GitHub App connection stays off`,
      );
    }
    if (app.privateKey && !app.id) {
      warnings.push("an app private key was found but GITHUB_APP_ID is missing: the GitHub App connection stays off");
    }
    if (localApp && !app.webhookSecret) {
      warnings.push(
        "GITHUB_WEBHOOK_SECRET is missing: POST /webhook/github answers 503, so installation changes show up only after Refresh or a restart",
      );
    }
    if (localApp && !app.slug) {
      warnings.push(
        'GITHUB_APP_SLUG is missing: the overview shows no "Add repository" button, so users cannot connect repositories',
      );
    }
  }
  if (cell.cellSecret && !cell.tokenMintUrl) {
    warnings.push("CELL_SECRET is set but TOKEN_MINT_URL is missing: remote token minting stays off");
  }
  if (cell.tenantInstallationId !== undefined && !remoteMinting && !localApp) {
    warnings.push(
      "TENANT_INSTALLATION_ID is set but no installation token can be minted (TOKEN_MINT_URL + CELL_SECRET, or GITHUB_APP_ID + an app private key): no repository is served",
    );
  }
  if (configuration.auth === "none") {
    const ignored = setVariables({
      LIVE_OIDC_ISSUER: oidc.issuer,
      LIVE_OIDC_JWKS_URL: oidc.jwksUrl,
      LIVE_OIDC_AUDIENCE: oidc.audience,
      LIVE_OIDC_LOGIN_CLAIM: oidc.loginClaim,
      LIVE_OIDC_CLIENT_ID: oidc.clientId,
      LIVE_OIDC_CLIENT_SECRET: oidc.clientSecret,
      LIVE_OIDC_AUTHORIZE_URL: oidc.authorizeUrl,
      LIVE_OIDC_TOKEN_URL: oidc.tokenUrl,
      LIVE_OIDC_LOGIN_LABEL: oidc.loginLabel,
    });
    if (ignored.length) {
      warnings.push(
        `${listed(ignored)} ${ignored.length === 1 ? "is" : "are"} set but LIVE_AUTH=none ignores ${
          ignored.length === 1 ? "it" : "them"
        }: an unauthenticated host has no login`,
      );
    }
  } else {
    if (Boolean(oidc.authorizeUrl) !== Boolean(oidc.tokenUrl)) {
      const [given, absent, endpoint] = oidc.authorizeUrl
        ? ["LIVE_OIDC_AUTHORIZE_URL", "LIVE_OIDC_TOKEN_URL", "token"]
        : ["LIVE_OIDC_TOKEN_URL", "LIVE_OIDC_AUTHORIZE_URL", "authorize"];
      // the issuer as auth/oidc-login.ts fetches it: an Auth0 issuer ends in a slash
      const discovery = oidc.issuer ? ` at ${oidc.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration` : "";
      warnings.push(
        `${given} is set but ${absent} is missing: the ${endpoint} endpoint still comes from OIDC discovery${discovery}`,
      );
    }
    if (!configuration.sessionKey) {
      warnings.push(
        "SESSION_ENC_KEY is not set: the login state key is random per boot, so a restart or redeploy breaks the logins in flight",
      );
    }
  }
  const retiredSet = setVariables({
    GITHUB_CLIENT_ID: retired.clientId,
    GITHUB_CLIENT_SECRET: retired.clientSecret,
  });
  if (retiredSet.length) {
    warnings.push(
      `${listed(retiredSet)} ${retiredSet.length === 1 ? "is" : "are"} no longer read (ADR 0007 retired the GitHub OAuth login): remove ${
        retiredSet.length === 1 ? "it" : "them"
      }, the login is LIVE_OIDC_*`,
    );
  }
  return warnings;
}

function setVariables(values: Record<string, string | undefined>): string[] {
  return Object.entries(values)
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name);
}

function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
