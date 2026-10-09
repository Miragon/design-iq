/**
 * A person's favorites and recently opened repositories (#213,
 * src/application/favorites.ts) on the real SQLite store
 * (src/adapters/sqlite/favorites-store.ts, in-memory): the access gate on
 * adding and visiting, the always-possible removal, the cap counted over
 * connected repositories, the per-user key, and the bounded visit list
 * (injected clock).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { AppError } from "@designiq/http-kit";

import { SqliteFavoritesStore } from "../src/adapters/sqlite/favorites-store.ts";
import type { Session } from "../src/adapters/sqlite/sessions.ts";
import {
  addFavorite,
  type FavoritesDeps,
  MAX_FAVORITES,
  MAX_VISITS,
  personalView,
  recordVisit,
  removeFavorite,
  userKey,
  VISIT_TTL_MS,
} from "../src/application/favorites.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const repo = (fullName: string, providerId: number | null = null): ConnectedRepo => ({
  fullName,
  defaultBranch: "main",
  private: true,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
  providerId,
});

const session = (login: string, provider = "oidc", id = `sess-${login}`): Session => ({
  id,
  user: { login, name: login, avatarUrl: null, provider },
  createdAt: Date.now(),
});

function setup(opts: { repos?: ConnectedRepo[]; denied?: string[]; now?: () => number } = {}) {
  let repos = opts.repos ?? [repo("acme/models", 4711), repo("acme/claims"), repo("acme/secret")];
  const denied = new Set(opts.denied ?? ["acme/secret"]);
  const db = new DatabaseSync(":memory:");
  const store = new SqliteFavoritesStore(db);
  const deps: FavoritesDeps = {
    registry: {
      get: (n) => repos.find((r) => r.fullName.toLowerCase() === n.toLowerCase()),
      list: () => repos,
    },
    access: { canWrite: async (_s, r) => !denied.has(r.fullName) },
    favorites: store,
    now: opts.now,
  };
  return { deps, store, db, setRepos: (next: ConnectedRepo[]) => (repos = next) };
}

const status = (e: unknown): number => (e instanceof AppError ? e.status : -1);

test("addFavorite: an accessible repo becomes a favorite, idempotently, under its canonical name", async () => {
  const { deps, store, db } = setup();
  const petra = session("Petra");
  assert.deepEqual(await addFavorite(deps, petra, "ACME/Models"), { fullName: "acme/models", favorite: true });
  assert.deepEqual(await addFavorite(deps, petra, "acme/models"), { fullName: "acme/models", favorite: true });
  assert.deepEqual(store.favorites(userKey(petra.user)), ["acme/models"]);
  const row = db.prepare("SELECT user, repo, provider_id FROM favorites").get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { user: "oidc:petra", repo: "acme/models", provider_id: 4711 });
});

test("addFavorite: 404 for an unconnected repo, 403 for one the person cannot access", async () => {
  const { deps } = setup();
  await assert.rejects(addFavorite(deps, session("petra"), "acme/unknown"), (e) => status(e) === 404);
  await assert.rejects(addFavorite(deps, session("petra"), "acme/secret"), (e) => status(e) === 403);
});

test("removeFavorite: needs no access and works for any name — connected or not", async () => {
  const { deps, store, setRepos } = setup();
  const petra = session("petra");
  await addFavorite(deps, petra, "acme/claims");
  setRepos([repo("acme/models")]); // acme/claims got disconnected
  assert.deepEqual(removeFavorite(deps, petra, "acme/claims"), { fullName: "acme/claims", favorite: false });
  assert.deepEqual(removeFavorite(deps, petra, "nobody/never-existed"), {
    fullName: "nobody/never-existed",
    favorite: false,
  });
  assert.deepEqual(removeFavorite(deps, petra, "ACME/MODELS"), { fullName: "acme/models", favorite: false });
  assert.deepEqual(store.favorites(userKey(petra.user)), []);
});

test("addFavorite: the 101st favorite among CONNECTED repositories is refused with 409", async () => {
  const many = Array.from({ length: MAX_FAVORITES + 2 }, (_, i) => repo(`acme/r${String(i).padStart(3, "0")}`));
  const { deps, setRepos } = setup({ repos: many, denied: [] });
  const petra = session("petra");
  for (const r of many.slice(0, MAX_FAVORITES)) await addFavorite(deps, petra, r.fullName);
  await assert.rejects(addFavorite(deps, petra, many[MAX_FAVORITES]!.fullName), (e) => status(e) === 409);
  // re-adding one that already is a favorite is not a new one
  await addFavorite(deps, petra, many[0]!.fullName);
  // a disconnected repository's favorite stays stored but no longer counts
  setRepos(many.slice(1));
  await addFavorite(deps, petra, many[MAX_FAVORITES]!.fullName);
});

test("favorites are per person: same login in another session sees them, another login or provider does not", async () => {
  const { deps, store } = setup();
  await addFavorite(deps, session("petra", "oidc", "session-A"), "acme/models");
  const sessionB = session("petra", "oidc", "session-B");
  assert.equal(personalView(store, sessionB).favorite("acme/models"), true, "session B of the same login");
  assert.equal(personalView(store, session("PETRA", "oidc")).favorite("acme/models"), true, "login case");
  assert.equal(personalView(store, session("omar")).favorite("acme/models"), false);
  // a LIVE_AUTH=none host's principal of the same name is someone else
  assert.equal(personalView(store, session("petra", "local")).favorite("acme/models"), false);
});

test("recordVisit: 404/403 like the favorites PUT; at most one stored visit per repo and minute", async () => {
  let now = Date.parse("2026-10-09T08:00:00Z");
  const { deps, store } = setup({ now: () => now });
  const petra = session("petra");
  await assert.rejects(recordVisit(deps, petra, "acme/unknown"), (e) => status(e) === 404);
  await assert.rejects(recordVisit(deps, petra, "acme/secret"), (e) => status(e) === 403);
  assert.deepEqual(await recordVisit(deps, petra, "acme/models"), {
    fullName: "acme/models",
    lastOpenedAt: "2026-10-09T08:00:00.000Z",
  });
  now += 30_000;
  assert.equal((await recordVisit(deps, petra, "ACME/models")).lastOpenedAt, "2026-10-09T08:00:00.000Z");
  now += 31_000;
  assert.equal((await recordVisit(deps, petra, "acme/models")).lastOpenedAt, "2026-10-09T08:01:01.000Z");
  assert.equal(store.visits(userKey(petra.user)).length, 1, "one row per person and repository");
});

test("recordVisit: keeps at most 20 visits per person, none older than 90 days (injected clock)", async () => {
  const repos = Array.from({ length: MAX_VISITS + 5 }, (_, i) => repo(`acme/r${i}`));
  let now = Date.parse("2026-01-01T00:00:00Z");
  const { deps, store } = setup({ repos, denied: [], now: () => now });
  const petra = session("petra");
  const omar = session("omar");
  await recordVisit(deps, omar, "acme/r0");
  for (const r of repos) {
    now += 60_000;
    await recordVisit(deps, petra, r.fullName);
  }
  const visits = store.visits(userKey(petra.user));
  assert.equal(visits.length, MAX_VISITS);
  assert.equal(visits[0]?.repo, `acme/r${MAX_VISITS + 4}`, "newest first");
  assert.ok(!visits.some((v) => v.repo === "acme/r0"), "the oldest fell out");
  assert.equal(store.visits(userKey(omar.user)).length, 1, "another person's list is untouched");

  // 90 days later: the next write prunes everything older
  now += VISIT_TTL_MS + 1;
  await recordVisit(deps, petra, "acme/r0");
  assert.deepEqual(
    store.visits(userKey(petra.user)).map((v) => v.repo),
    ["acme/r0"],
  );
});

test("personalView: a visit past its TTL is gone even before a write prunes it", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const { deps, store } = setup({ now: () => now });
  const petra = session("petra");
  await recordVisit(deps, petra, "acme/models");
  assert.equal(personalView(store, petra, now).lastOpenedAt("acme/models"), "2026-01-01T00:00:00.000Z");
  now += VISIT_TTL_MS + 1;
  assert.equal(personalView(store, petra, now).lastOpenedAt("acme/models"), null);
  assert.equal(personalView(store, petra, now).lastOpenedAt("acme/claims"), null, "never opened");
});
