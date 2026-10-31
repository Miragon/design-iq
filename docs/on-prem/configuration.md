# Configuration reference

Every environment variable the Live Host reads, grouped by concern. Defaults in parentheses
are the source defaults ([`apps/live-host/src/server.ts`](https://github.com/Miragon/design-iq/blob/main/apps/live-host/src/server.ts)
is the only place that reads env); the Docker image overrides two of them (`PORT=8080`,
`LIVE_DATA_DIR=/data`). The annotated deployment template is
[`deploy/.env.example`](https://github.com/Miragon/design-iq/blob/main/deploy/.env.example).

See the [install guide](./) and
[github-app-setup.md](github-app-setup.md) for obtaining the GitHub App values.

## Startup report

When the Live Host is up it prints one banner. `mode` is the operating mode your settings
select, with the names of the [operating modes](./#operating-modes): `no auth (LIVE_AUTH=none)`
with a single repo or with the GitHub App, `OIDC + GitHub App` (recommended), or `cell`.
Below `OIDC + GitHub App`, `next mode` lists the settings that mode still needs. Every
`warning` names a setting that is only half there and what stays off because of it. A
secret shows up only as set or missing, never with its value. A setting the server cannot
run with still stops it with an error, as before. When `LIVE_AUTH=oidc` refuses the start
(no IdP, no GitHub App, or only one of `LIVE_OIDC_ISSUER` and `LIVE_OIDC_JWKS_URL`), the
warnings print just before the error, since one of them is often the reason.

```text
──────────────────────────────────────────────────
Live Host ready (single port)
mode      : no auth (LIVE_AUTH=none), GitHub App
next mode : OIDC + GitHub App, missing LIVE_OIDC_ISSUER, LIVE_OIDC_JWKS_URL and LIVE_OIDC_CLIENT_ID; then set LIVE_AUTH=oidc
host repo : acme/processes (local content: /app)
data dir  : /data
endpoint  : http://localhost:8080  (HTTP + WebSocket, one port)
repos     : acme/processes, acme/architecture
minting   : local (app key)
auth      : NONE (LIVE_AUTH=none): every request is @petra, every repository writable; local evaluation or a trusted network only
mcp       : POST /mcp
room name = <owner>/<repo>/<path>, Y.Text field 'content'
warning   : GITHUB_WEBHOOK_SECRET is missing: POST /webhook/github answers 503, so installation changes show up only after Refresh or a restart
──────────────────────────────────────────────────
```

| Warned about                                        | When                                     | What stays off                                       |
| --------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `GITHUB_APP_ID` and the app private key             | one without the other                    | the GitHub App connection (single-repo mode)         |
| `GITHUB_WEBHOOK_SECRET`                             | the App is connected, the secret missing | webhooks (`503`): changes arrive on Refresh only     |
| `GITHUB_APP_SLUG`                                   | the App is connected, the slug missing   | the overview's "Add repository" button               |
| `LIVE_OIDC_AUTHORIZE_URL` and `LIVE_OIDC_TOKEN_URL` | one without the other                    | skipping discovery: the other endpoint still uses it |
| `SESSION_ENC_KEY`                                   | `LIVE_AUTH=oidc` without it              | logins in flight surviving a restart                 |
| `LIVE_OIDC_*`                                       | set under `LIVE_AUTH=none`               | all of them: a host without auth has no login        |
| `CELL_SECRET` and `TOKEN_MINT_URL`                  | the secret without the URL               | remote token minting                                 |
| `TENANT_INSTALLATION_ID`                            | no token mint and no App key             | every repository                                     |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`          | either one set                           | retired by ADR 0007, not read: remove them           |

## Core

| Variable                | Default                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `8301` (image: `8080`)          | The one port for everything: REST API + WebSocket sync + web app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LIVE_PUBLIC_URL`       | `http://localhost:$PORT`        | **Must be the public HTTPS URL in production.** The OAuth callback and webhook URLs derive from it, and session cookies are only marked `Secure` when it starts with `https`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `LIVE_DATA_DIR`         | `<repo>/.live` (image: `/data`) | Host-owned state: `live.db` (Yjs lineages, sessions, repo registry, token cache) + `workspaces/` (cloned repos). Mount a volume here.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LIVE_AUTH`             | `oidc`                          | **The authentication mode ([ADR 0007](../adr/0007-idp-only-login-and-no-auth-mode.md)).** `oidc`: the identity provider is the one login. It requires the `LIVE_OIDC_*` block below **and** a GitHub App connection (per-repo authorization runs on installation tokens); the server refuses to start without either. `none`: **no authentication**. Every request, WebSocket join and MCP call is the local principal and every registered repository is writable. Local evaluation or a trusted single-team network only. Never inferred from missing configuration. |
| `LIVE_LOCAL_USER`       | the OS user name                | `LIVE_AUTH=none` only: the login of the local principal. Release commits and todos are attributed to it, so use your GitHub login. In a container the OS fallback is `root`/`node`: set it.                                                                                                                                                                                                                                                                                                                                                                            |
| `GITHUB_REPO`           | `Miragon/design-iq`             | Static fallback repository (`<owner>/<repo>`) registered when the GitHub App cannot enumerate installations (the single-repo mode). Set it to your own content repo; in app mode the installations take over.                                                                                                                                                                                                                                                                                                                                                          |
| `BASE_BRANCH`           | `main`                          | Default branch recorded for the static fallback repo (release PRs target the repo's default branch).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LIVE_HOST_CONTENT_DIR` | `<repo>` (the checkout root)    | Serve a local content checkout in place of cloning `GITHUB_REPO`. Takes effect only when the directory has a root `designiq.yml` (or legacy `bpmiq.yml`). Dev mode; not for production.                                                                                                                                                                                                                                                                                                                                                                                |

## GitHub App mode (recommended on-prem)

App id + private key switch the server into multi-repo mode: installation enumeration
drives the repo overview, per-(user,repo) authorization runs on installation tokens
([ADR 0001](../adr/0001-zero-stored-user-tokens.md)), and webhooks keep the connected set
current. Setup walkthrough: [github-app-setup.md](github-app-setup.md).

| Variable                | Default | Meaning                                                                                                                        |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_APP_ID`         | —       | The app's numeric id.                                                                                                          |
| `GITHUB_APP_SLUG`       | —       | The app's URL slug; powers the "connect repository" install-picker link. Without it users can't add repos.                     |
| `GITHUB_WEBHOOK_SECRET` | —       | Verifies `POST /webhook/github` (HMAC SHA-256). The receiver fails closed: no secret configured = webhooks refused with `503`. |

The **app private key** is resolved by the shared loader
([`packages/github-app/src/index.ts`](https://github.com/Miragon/design-iq/blob/main/packages/github-app/src/index.ts),
`loadPrivateKey`). The first match wins:

1. `GITHUB_APP_PRIVATE_KEY`: the raw PEM (a double-quoted multi-line `.env` value; must
   contain `PRIVATE KEY`)
2. `GITHUB_APP_PRIVATE_KEY_FILE`: path to a `.pem` file (mount the key as a file/secret)
3. `GITHUB_APP_PRIVATE_KEY_B64`: base64 one-liner (env-only deploys; what the guided
   setup writes)
4. the first `*.pem` found in `apps/live-host/`: local-dev convenience for source
   checkouts, not relevant in the container

`LIVE_WEBHOOK_URL` is read only by the `create-app` tool (it sets the webhook URL in the
app manifest, defaulting to `$LIVE_PUBLIC_URL/webhook/github` when the public URL isn't
localhost). The running server always receives webhooks at `/webhook/github`.

## OIDC: token auth (MCP & headless) + browser SSO

Connects the Live Host to your identity provider (Keycloak, Entra ID, WorkOS, Auth0, …, with
GitHub as a social connection behind it), for two things on ONE identity contract. No IdP
yet? [idp-quickstart.md](idp-quickstart.md) ships a Keycloak realm with these values filled in.

1. **Token auth**: MCP clients and other headless callers authenticate with an
   audience-bound JWT. The Live Host only **verifies** tokens (a resource server); it
   never runs its own authorization server.
2. **Browser SSO** (`LIVE_OIDC_CLIENT_ID`): the web login runs the IdP's hosted flow
   (authorization code + PKCE). The flow's access token is validated by the **same
   verifier** as MCP bearers: same issuer, audience and login claim, fail-closed. It is
   the only browser login ([ADR 0007](../adr/0007-idp-only-login-and-no-auth-mode.md)):
   in `oidc` mode all three variables are required.

Identity is not authorization: per-repo write permission is still checked app-side
against real GitHub permissions, which requires the GitHub-App connection source
(OIDC sessions hold no user token). When configured, the server publishes RFC-9728
protected-resource metadata at `/.well-known/oauth-protected-resource` and 401 responses
carry `WWW-Authenticate: Bearer resource_metadata="…"`, so MCP clients discover your IdP
automatically. A verified, click-by-click IdP setup (WorkOS AuthKit) lives in
[extending/mcp-idp-setup.md](../extending/mcp-idp-setup.md). Decision record:
[ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md).

| Variable                  | Default           | Meaning                                                                                                                                                                                            |
| ------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIVE_OIDC_ISSUER`        | —                 | The IdP's issuer URL (expected `iss` claim). Must be set together with `LIVE_OIDC_JWKS_URL`; one without the other refuses startup.                                                                |
| `LIVE_OIDC_JWKS_URL`      | —                 | The IdP's JWKS endpoint, used to verify token signatures.                                                                                                                                          |
| `LIVE_OIDC_AUDIENCE`      | `LIVE_PUBLIC_URL` | The audience (`aud`) tokens must be bound to: this instance.                                                                                                                                       |
| `LIVE_OIDC_LOGIN_CLAIM`   | `github_login`    | The claim carrying the user's GitHub login. **Must be IdP-populated with the verified GitHub login, never user-editable.** A token without it is refused (no `preferred_username`/`sub` fallback). |
| `LIVE_OIDC_CLIENT_ID`     | —                 | **Required in `oidc` mode**: the web login runs the IdP's code+PKCE flow; the flow's access token is verified by the issuer/JWKS pair above.                                                       |
| `LIVE_OIDC_CLIENT_SECRET` | —                 | Optional: set for a confidential client (Keycloak default); unset = public client, PKCE only.                                                                                                      |
| `LIVE_OIDC_AUTHORIZE_URL` | discovery         | Explicit authorize endpoint. Default: resolved from `<issuer>/.well-known/openid-configuration` (lazily, cached). Set both URL overrides for air-gapped hosts.                                     |
| `LIVE_OIDC_TOKEN_URL`     | discovery         | Explicit token endpoint (see above).                                                                                                                                                               |
| `LIVE_OIDC_LOGIN_LABEL`   | `SSO`             | The web client's login-button label (e.g. "Acme SSO").                                                                                                                                             |
| `LIVE_MCP_READONLY`       | —                 | `1` = the MCP endpoint registers **no** write tools (absent from `tools/list`, not erroring).                                                                                                      |
| `LIVE_MCP_BPMN_EDIT`      | —                 | `1` = the MCP endpoint also registers the semantic BPMN tools `get_process_outline`, `edit_process` and `layout_process` (ADR 0009; opt-in until their benchmark gate has run).                    |

The IdP-side requirement is identical for both entrances: access tokens must be JWTs
carrying the audience and the login claim (Keycloak: an audience mapper + a
user-attribute mapper on the client; Entra ID: an optional claim fed from a directory
attribute; WorkOS: a JWT template). What works for `/mcp` works for the browser login
and vice versa.

## GitHub Enterprise

| Variable          | Default                  | Meaning                                                                                                                  |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_BASE_URL` | `https://github.com`     | Web base: login, install picker, git clone URLs, and a document's links to its models on GitHub, which open in designIQ. |
| `GITHUB_API_URL`  | `https://api.github.com` | REST API base.                                                                                                           |

## Security & limits

| Variable             | Default         | Meaning                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SESSION_ENC_KEY`    | random per boot | HMAC key for the browser-bound login `state`, so a restart or redeploy mid-login keeps in-flight logins valid (the name predates [ADR 0007](../adr/0007-idp-only-login-and-no-auth-mode.md); nothing is encrypted any more, because no credential is stored). Fallback: `CELL_TOKEN_KEY`. **Set it explicitly in production.** |
| `LIVE_MAX_DOC_BYTES` | `8000000`       | Per-room document size cap (DoS guard), enforced at ingest and at persist.                                                                                                                                                                                                                                                     |
| `LIVE_MAX_WS`        | `400`           | Global WebSocket connection ceiling.                                                                                                                                                                                                                                                                                           |
| `LIVE_MAX_WS_PER_IP` | `40`            | Per-IP WebSocket ceiling. Client IP = `Fly-Client-IP` header, falling back to the socket address. Behind a reverse proxy, set the header at the proxy or all users share one bucket (see [Reverse proxy / TLS](./#reverse-proxy--tls)).                                                                                        |
| `LIVE_SHUTDOWN_MS`   | `25000`         | Graceful-shutdown budget: on SIGTERM/SIGINT the server flushes debounced write-throughs, hard-exiting after this many ms. Keep it below the container runtime's kill timeout (compose sets `stop_grace_period: 30s`).                                                                                                          |

## Dev/test only: never set in production

| Variable                 | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `LIVE_GIT_URL_OVERRIDE`  | Redirect clone/fetch URLs to a stub git server (test harness). |
| `LIVE_PUSH_URL_OVERRIDE` | Redirect release pushes to a stub git server (test harness).   |

## Cell mode: leave unset on-prem

`TENANT_INSTALLATION_ID`, `TOKEN_MINT_URL`, `CELL_SECRET`, `CELL_TOKEN_KEY`
are used by Miragon's hosted multi-tenant operation, where a control plane
holds the GitHub App key and each tenant gets its own cell
([ADR 0002](../adr/0002-multi-tenant-cell-architecture.md),
[ADR 0004](../adr/0004-open-source-split.md)). Leave **all** of them unset: the server
then runs standalone with its own app key, which is the on-prem model.

When `TENANT_INSTALLATION_ID` **is** set (cell mode) **and** `LIVE_OIDC_*` is configured,
the OIDC verifier additionally requires every token to carry `installation_id` equal to
this cell's tenant, refusing anything else with `401 auth/wrong-tenant`. This is the tenant
boundary in the SaaS, where the OIDC audience is a shared fleet value (the IdP's resource
indicators are one per environment, not per tenant): the claim is IdP-injected from the
user's organization membership, so a token minted for another tenant fails here. On-prem
(single tenant, `TENANT_INSTALLATION_ID` unset) this check is inert.
