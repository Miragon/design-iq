/**
 * Repository images for the Markdown view (#290) over real HTTP: the
 * image route answers under the content API's authorization, serves image
 * types only and none past the size cap, keeps to the repository's files
 * (no dot segment, no symlink out), revalidates by ETag, and serves an SVG
 * so that opened on its own it runs no script.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import { REPO_IMAGE_MAX_BYTES, repoImageRoute } from "@designiq/contracts/live";

import { SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { locateRepoImage } from "../src/application/repo-image.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const repo = (fullName: string): ConnectedRepo => ({
  fullName,
  defaultBranch: "main",
  private: true,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
});
const MODELS = repo("acme/models");
const SECRET = repo("acme/secret");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

let base = "";
let workspace = "";
let AUTH: Record<string, string> = {};
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
});

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), "designiq-image-"));
  const outside = mkdtempSync(join(tmpdir(), "designiq-host-"));
  mkdirSync(join(workspace, "docs", "assets"), { recursive: true });
  mkdirSync(join(workspace, ".github"), { recursive: true });
  writeFileSync(join(workspace, "docs", "assets", "map.png"), PNG);
  writeFileSync(join(workspace, "docs", "assets", "Map Copy.PNG"), PNG);
  writeFileSync(join(workspace, "docs", "logo.svg"), SVG);
  writeFileSync(join(workspace, "docs", "notes.md"), "# notes");
  writeFileSync(join(workspace, ".github", "logo.png"), PNG);
  writeFileSync(join(workspace, "docs", "huge.png"), "");
  truncateSync(join(workspace, "docs", "huge.png"), REPO_IMAGE_MAX_BYTES + 1);
  writeFileSync(join(outside, "host.png"), PNG);
  symlinkSync(join(outside, "host.png"), join(workspace, "docs", "escape.png"));

  const sessions = new SessionStore(new DatabaseSync(":memory:"));
  AUTH = {
    authorization: `Bearer ${sessions.create({ login: "petra", name: "Petra", avatarUrl: null, provider: "github" }).id}`,
  };
  const registry = { get: (n: string) => [MODELS, SECRET].find((r) => r.fullName === n), list: () => [MODELS, SECRET] };
  const opts: ApiOptions = {
    webDist: mkdtempSync(join(tmpdir(), "designiq-webdist-")),
    publicUrl: "http://live.test",
    github: {} as GitProvider,
    sessions,
    registry: registry as ApiOptions["registry"],
    workspaces: { ensure: async () => workspace } as unknown as ApiOptions["workspaces"],
    access: { canWrite: async (_s, r) => r.fullName !== SECRET.fullName, invalidate: () => {} },
    liveDocs: () => [],
    dropLineage: () => {},
    renameLineage: () => {},
    saveLineage: () => {},
    rooms: { retire: () => undefined, hold: () => () => {} },
    openDoc: () => Promise.reject(new Error("no live documents in this suite")),
    maxDocBytes: 8_000_000,
  };
  const server = startApi(0, opts);
  cleanups.push(() => new Promise((r) => server.close(r)));
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

const get = (route: string, headers: Record<string, string> = AUTH) => fetch(`${base}${route}`, { headers });
const image = (path: string, repoName = MODELS.fullName) => get(repoImageRoute(repoName, path));

test("a repository image is served with its type, revalidated by ETag, never cached for others", async () => {
  const res = await image("docs/assets/map.png");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "private, no-cache");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);

  const etag = res.headers.get("etag") ?? "";
  assert.match(etag, /^W\/"/);
  const again = await get(repoImageRoute(MODELS.fullName, "docs/assets/map.png"), { ...AUTH, "if-none-match": etag });
  assert.equal(again.status, 304);

  // the extension decides the type, whatever its case
  const upper = await image("docs/assets/Map Copy.PNG");
  assert.equal(upper.status, 200);
  assert.equal(upper.headers.get("content-type"), "image/png");
});

test("an SVG opened on its own runs no script and loads nothing", async () => {
  const res = await image("docs/logo.svg");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml");
  assert.equal(
    res.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
  );
});

test("the content API's authorization: signed in, and write access to the repository", async () => {
  assert.equal((await get(repoImageRoute(MODELS.fullName, "docs/assets/map.png"), {})).status, 401);
  assert.equal((await image("docs/assets/map.png", SECRET.fullName)).status, 403);
  assert.equal((await image("docs/assets/map.png", "acme/unknown")).status, 404);
});

test("only images, only the repository's own files, none past the size cap", async () => {
  const status = async (path: string) => {
    const res = await image(path);
    return [res.status, ((await res.json()) as { code?: string }).code];
  };
  assert.deepEqual(await status("docs/notes.md"), [415, "image/unsupported-type"]);
  assert.deepEqual(await status("docs/missing.png"), [404, "image/not-found"]);
  assert.deepEqual(await status("docs/assets"), [415, "image/unsupported-type"]);
  assert.deepEqual(await status(".github/logo.png"), [400, "image/invalid-path"]);
  assert.deepEqual(await status("docs/../../etc/x.png"), [400, "image/invalid-path"]);
  assert.deepEqual(await status("/etc/x.png"), [400, "image/invalid-path"]);
  assert.deepEqual(await status("docs/escape.png"), [400, "image/invalid-path"]);
  assert.deepEqual(await status("docs/huge.png"), [413, "image/too-large"]);
  const missing = await get(`/api/repos/${MODELS.fullName}/image`);
  assert.equal(missing.status, 400);
  const post = await fetch(`${base}${repoImageRoute(MODELS.fullName, "docs/assets/map.png")}`, {
    method: "POST",
    headers: AUTH,
  });
  assert.equal(post.status, 405);
});

test("locateRepoImage: a folder named like an image is no image", async () => {
  mkdirSync(join(workspace, "docs", "folder.png"), { recursive: true });
  await assert.rejects(locateRepoImage({ workspaces: { ensure: async () => workspace } }, MODELS, "docs/folder.png"), {
    code: "image/not-found",
  });
});
