# Get started with designIQ

You need Docker for the host. The read-only MCP server and the validator run with `npx` and need Node.js 22 or later.

## Run the evaluation container

This container runs without login and serves the example models from the designIQ repo, which it clones on the first request. Anyone who reaches the port can edit every model, so keep it on your machine.

```sh
docker run --rm -p 8301:8080 \
  -e LIVE_AUTH=none \
  -e LIVE_PUBLIC_URL=http://localhost:8301 \
  ghcr.io/miragon/designiq-live-host:latest
```

`LIVE_PUBLIC_URL` is the URL you open in the browser. If you publish another port, change it there too, or the editors never sync.

Open `http://localhost:8301`, pick the repo Miragon/design-iq and open the BPMN model `order-to-cash`. `--rm` throws the container away when you stop it, with every edit you made.

## Connect an AI client

Claude Code connects to the `/mcp` endpoint of the running host and edits the same live models. On a `LIVE_AUTH=none` host it needs no credential. Without a running host, your MCP client can start the read-only server itself, as a stdio process on any checkout.

::: code-group

```sh [Claude Code, live]
claude mcp add --transport http designiq http://localhost:8301/mcp
```

```sh [Any checkout, read-only]
npx @miragon/design-iq-mcp --root ./my-content-repo
```

:::

Claude Desktop, other clients and a host with login: [MCP integration](./mcp-integration.md).

## Use your own models

A content repo is any Git repo with a root `designiq.yml` that names its models folder, for example `models: processes`. Create one from the template [process-documentation-starter](https://github.com/Miragon/process-documentation-starter), then give it to the container. The volume keeps the clone and the live edits across restarts.

::: code-group

```sh [Public repo on GitHub]
docker run -p 8301:8080 \
  -e LIVE_AUTH=none \
  -e LIVE_PUBLIC_URL=http://localhost:8301 \
  -e GITHUB_REPO=<owner>/<repo> \
  -v designiq-data:/data \
  ghcr.io/miragon/designiq-live-host:latest
```

```sh [Local checkout]
docker run -p 8301:8080 \
  -e LIVE_AUTH=none \
  -e LIVE_PUBLIC_URL=http://localhost:8301 \
  -e GITHUB_REPO=acme/my-processes \
  -e LIVE_HOST_CONTENT_DIR=/content \
  -v "$PWD/my-processes:/content" \
  -v designiq-data:/data \
  ghcr.io/miragon/designiq-live-host:latest
```

:::

Without a GitHub App, the host clones without credentials, so the repo has to be public. A local checkout is served in place: edits write through to your working tree, `git diff` shows them, and you commit as usual. `GITHUB_REPO` is then only a label.

Login, private repos and release as pull request need an OIDC provider and your own GitHub App. The [IdP quickstart](./on-prem/idp-quickstart.md) starts a Keycloak with a ready realm, [GitHub App setup](./on-prem/github-app-setup.md) registers the App, and the [self-hosting guide](./on-prem/) covers the rest.

## Validate your models

After model edits, check the content repo, on your machine or as a gate in CI. Exit code 1 means errors.

```sh
npx @miragon/design-iq-validator --root .
```
