/**
 * The start page's HTTP surface (#213) over real HTTP + real Hocuspocus rooms:
 *
 *   PUT/DELETE /api/me/favorites/:fullName — the access gate on adding
 *     (404/403 like every repo route), the always-possible removal, the 409
 *     past the cap, and persistence per login across sessions;
 *   PUT /api/me/recent/:fullName — a visit, and only that: listing a repo's
 *     models leaves lastOpenedAt alone;
 *   GET /api/repos lastChangeAt — a real edit marks the repo; reading it,
 *     seeding its room, awareness-only traffic and a write of identical text
 *     do not.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import type { ContentWire, RepoInfo } from "@designiq/contracts/live-host";
import { Server as HocuspocusServer } from "@hocuspocus/server";

import { SqliteActivityStore } from "../src/adapters/sqlite/activity-store.ts";
import { SqliteFavoritesStore } from "../src/adapters/sqlite/favorites-store.ts";
import { LineageStore } from "../src/adapters/sqlite/lineage-store.ts";
import { SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "../src/application/collab.ts";
import { MAX_FAVORITES, userKey } from "../src/application/favorites.ts";
import { RepoActivity } from "../src/application/repo-activity.ts";
import { newBpmnXml } from "../src/domain/bpmn-template.ts";
import { DocSizeGuard } from "../src/domain/doc-size-guard.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";
import { CONTENT_CONFIG_FILE, loadContentConfig } from "../src/repos/content.ts";
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
/** enough further connected repositories to fill a person's favorites to the cap */
const FILLERS = Array.from({ length: MAX_FAVORITES }, (_, i) => repo(`acme/f${i}`));
const REPOS = [MODELS, SECRET, ...FILLERS];
const PATH = "processes/order.bpmn";
const XML = newBpmnXml("order", "Order");

let base = "";
let hp: HocuspocusServer;
let favorites: SqliteFavoritesStore;
/** Bearer headers: two sessions of petra, one of omar (who may not see acme/secret either) */
const as: Record<"petraA" | "petraB" | "omar", Record<string, string>> = { petraA: {}, petraB: {}, omar: {} };
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const c of cleanups) await c();
  // WATCHDOG (see api-content.test.ts): a passed suite must never hang on a Hocuspocus handle
  setTimeout(() => process.exit(), 2000).unref();
});

before(async () => {
  const ws = mkdtempSync(join(tmpdir(), "designiq-start-"));
  mkdirSync(join(ws, "processes"), { recursive: true });
  writeFileSync(join(ws, CONTENT_CONFIG_FILE), "models: processes\n");
  writeFileSync(join(ws, PATH), XML);
  const registry = {
    get: (n: string) => REPOS.find((r) => r.fullName === n.toLowerCase()),
    list: () => REPOS,
  };
  const wsFns = {
    ensure: async () => ws,
    dir: () => ws,
    changedPaths: async () => [],
    changedFiles: async () => [],
  };
  const access = { canWrite: async (_s: unknown, r: ConnectedRepo) => r.fullName !== SECRET.fullName };
  const db = new DatabaseSync(":memory:");
  const activity = new RepoActivity({ store: new SqliteActivityStore(db) });
  favorites = new SqliteFavoritesStore(db);
  hp = new HocuspocusServer({
    ...makeCollabHooks({
      lineage: new LineageStore(db, MODELS.fullName),
      docGuard: new DocSizeGuard(8_000_000),
      maxDocBytes: 8_000_000,
      sessions: { get: () => undefined },
      access,
      registry,
      workspaces: wsFns,
      contentConfig: loadContentConfig,
      liveDocs: new Set(),
      activity,
    }),
  });
  cleanups.push(() => hp.destroy());
  const sessions = new SessionStore(db);
  for (const [key, login] of [
    ["petraA", "petra"],
    ["petraB", "petra"],
    ["omar", "omar"],
  ] as const) {
    as[key] = {
      authorization: `Bearer ${sessions.create({ login, name: login, avatarUrl: null, provider: "oidc" }).id}`,
    };
  }
  const opts: ApiOptions = {
    webDist: mkdtempSync(join(tmpdir(), "designiq-webdist-")),
    publicUrl: "http://live.test",
    github: {} as GitProvider,
    sessions,
    registry: registry as ApiOptions["registry"],
    workspaces: wsFns as unknown as ApiOptions["workspaces"],
    access: { ...access, invalidate: () => {} },
    liveDocs: () => [],
    dropLineage: () => {},
    renameLineage: () => {},
    saveLineage: () => {},
    rooms: { retire: () => undefined, hold: () => () => {} },
    openDoc: (room) => hp.hocuspocus.openDirectConnection(room),
    maxDocBytes: 8_000_000,
    favorites,
    activity,
  };
  const httpServer = startApi(0, opts);
  cleanups.push(() => new Promise((r) => httpServer.close(r)));
  await new Promise<void>((r) => httpServer.once("listening", r));
  base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
});

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const listRepos = async (headers: Record<string, string>): Promise<RepoInfo[]> => {
  const res = await call("GET", "/api/repos", headers);
  assert.equal(res.status, 200);
  return (await res.json()) as RepoInfo[];
};
const row = async (headers: Record<string, string>, fullName = MODELS.fullName) =>
  (await listRepos(headers)).find((r) => r.fullName === fullName);

test("favorites: PUT in one session shows in another session of the same login, never for someone else", async () => {
  const res = await call("PUT", "/api/me/favorites/acme/models", as.petraA);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { fullName: "acme/models", favorite: true });
  assert.equal((await row(as.petraB))?.favorite, true, "session B of the same login");
  assert.equal((await row(as.omar))?.favorite, false);
  const again = await call("PUT", "/api/me/favorites/ACME/Models", as.petraB);
  assert.deepEqual(await again.json(), { fullName: "acme/models", favorite: true }, "idempotent, canonical name");

  const del = await call("DELETE", "/api/me/favorites/acme/models", as.petraB);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { fullName: "acme/models", favorite: false });
  assert.equal((await row(as.petraA))?.favorite, false);
});

test("favorites: PUT answers 404 unconnected, 403 inaccessible; DELETE succeeds for any name", async () => {
  const unknown = await call("PUT", "/api/me/favorites/acme/unknown", as.petraA);
  assert.equal(unknown.status, 404);
  assert.match(((await unknown.json()) as { error: string }).error, /not a connected repository/);
  assert.equal((await call("PUT", "/api/me/favorites/acme/secret", as.petraA)).status, 403);
  for (const name of ["acme/unknown", "acme/secret", "group/sub/project"]) {
    const res = await call("DELETE", `/api/me/favorites/${name}`, as.petraA);
    assert.equal(res.status, 200, `DELETE ${name}`);
    assert.deepEqual(await res.json(), { fullName: name, favorite: false });
  }
  assert.equal((await call("POST", "/api/me/favorites/acme/models", as.petraA)).status, 405);
  assert.equal((await call("PUT", "/api/me/favorites/acme/models", {})).status, 401);
});

test("favorites: past the cap the PUT answers 409 with a message", async () => {
  const user = userKey({ login: "omar", name: "omar", avatarUrl: null, provider: "oidc" });
  for (const r of FILLERS) favorites.addFavorite(user, r.fullName, null, 0);
  const refused = await call("PUT", "/api/me/favorites/acme/models", as.omar);
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, new RegExp(`${MAX_FAVORITES} favorites`));
  assert.equal((await row(as.omar))?.favorite, false);
  // one removed, one added
  assert.equal((await call("DELETE", "/api/me/favorites/acme/f0", as.omar)).status, 200);
  assert.equal((await call("PUT", "/api/me/favorites/acme/models", as.omar)).status, 200);
  for (const r of [MODELS, ...FILLERS]) favorites.removeFavorite(user, r.fullName);
});

test("recent: a PUT records the visit; listing the repo's models does not", async () => {
  const before = await row(as.petraA);
  assert.equal(before?.lastOpenedAt, null);
  const res = await call("PUT", "/api/me/recent/acme/models", as.petraA);
  assert.equal(res.status, 200);
  const { lastOpenedAt } = (await res.json()) as { lastOpenedAt: string };
  assert.equal((await row(as.petraB))?.lastOpenedAt, lastOpenedAt, "per login, across sessions");
  assert.equal((await row(as.omar))?.lastOpenedAt, null);
  assert.equal((await call("GET", "/api/repos/acme/models/models", as.omar)).status, 200);
  assert.equal((await row(as.omar))?.lastOpenedAt, null, "a GET …/models is not a visit");
  assert.equal((await call("PUT", "/api/me/recent/acme/secret", as.petraA)).status, 403);
  assert.equal((await call("PUT", "/api/me/recent/acme/unknown", as.petraA)).status, 404);
  assert.equal((await call("DELETE", "/api/me/recent/acme/models", as.petraA)).status, 405);
});

test("lastChangeAt: reads, seeding, awareness and an identical write leave it alone — a real edit sets it", async () => {
  assert.equal((await row(as.petraA))?.lastChangeAt, null, "no signal yet (the workspace exists — no fallback)");
  // a peer opens the room: it is seeded from the workspace file and stays loaded
  const peer = await hp.hocuspocus.openDirectConnection(`acme/models/${PATH}`);
  cleanups.unshift(() => peer.disconnect());
  // awareness-only traffic on the loaded room
  const doc = hp.hocuspocus.documents.get(`acme/models/${PATH}`);
  assert.ok(doc, "the room is loaded");
  doc.awareness.setLocalState({ user: { name: "someone" }, cursor: { x: 1 } });
  // a REST read of the live content
  const got = await call("GET", `/api/repos/acme/models/content?path=${encodeURIComponent(PATH)}`, as.petraA);
  assert.equal(got.status, 200);
  const { content, baseVersion } = (await got.json()) as ContentWire;
  // a write of identical content changes nothing in the document
  const same = await call("PUT", `/api/repos/acme/models/content?path=${encodeURIComponent(PATH)}`, as.petraA, {
    content,
    baseVersion,
  });
  assert.equal(same.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await row(as.petraA))?.lastChangeAt, null);

  const edited = await call("PUT", `/api/repos/acme/models/content?path=${encodeURIComponent(PATH)}`, as.petraA, {
    content: newBpmnXml("order", "Order v2"),
    baseVersion: ((await same.json()) as { baseVersion: string }).baseVersion,
  });
  assert.equal(edited.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const changed = (await row(as.omar))?.lastChangeAt;
  assert.equal(typeof changed, "string", "the same for everyone");
  assert.ok(Date.now() - Date.parse(changed as string) < 10_000);
});
