/**
 * The Miragon renderers take diagram-js, didi and tiny-svg (most of them zod
 * too) as peers: they draw with the copies apps/web brings. A second copy in
 * the bundle fails only at runtime (a second didi breaks diagram-js's injector,
 * a second zod `instanceof` and schema identity, a second @miragon/modeler-api
 * the contract the renderers and live-client meet on) while the build and the
 * type check pass. So apps/web pins every peer of its Miragon packages exactly
 * instead of leaving it to pnpm's autoInstallPeers, and the lockfile resolves
 * each of these runtimes to one copy in everything apps/web ships: its
 * dependencies and those of the workspace packages it links. devDependencies
 * are left out: they are build and test tools, never bundled (#300).
 *
 * didi and tiny-svg are the exception: the renderers share them with the
 * diagram-js they draw with, so one copy has to hold there, in what the
 * renderers reach. A library outside that may bring its own copy without
 * touching the renderers' injector: dmn-js 18's dmn-js-shared builds an
 * injector of its own on didi 12, while its diagram-js and table-js stay on
 * didi 11.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";

import { parse } from "yaml";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

type ImporterDependencies = Record<string, { version: string }>;
type SnapshotDependencies = Record<string, string>;
interface Lockfile {
  importers: Record<string, { dependencies?: ImporterDependencies; optionalDependencies?: ImporterDependencies }>;
  packages: Record<
    string,
    { peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
  >;
  snapshots: Record<string, { dependencies?: SnapshotDependencies; optionalDependencies?: SnapshotDependencies }>;
}
const lock = parse(read("../../../pnpm-lock.yaml")) as Lockfile;
const web = JSON.parse(read("../package.json")) as { dependencies: Record<string, string> };
const WEB_IMPORTER = "apps/web";

/** "0.10.0(diagram-js@15.28.1)" → "0.10.0": a lockfile version without its peer suffix */
const bare = (version: string): string => version.replace(/\(.*$/, "");
/** "@miragon/modeler-api@1.3.0" → "@miragon/modeler-api" */
const packageName = (snapshotKey: string): string => snapshotKey.slice(0, snapshotKey.indexOf("@", 1));
/** an npm alias's version already reads "<real name>@<version>" */
const snapshotKey = (name: string, version: string): string =>
  /^(@[^/@]+\/)?[^/@:(]+@/.test(version) ? version : `${name}@${version}`;

/** the peers a package draws with; an optional one is a tool it brings only
 *  where the host has it (modeler-shell's VS Code and Playwright drivers),
 *  never a runtime apps/web hands it */
function requiredPeers(packageKey: string): string[] {
  const { peerDependencies = {}, peerDependenciesMeta = {} } = lock.packages[packageKey] ?? {};
  return Object.keys(peerDependencies).filter((peer) => peerDependenciesMeta[peer]?.optional !== true);
}

const miragonPackages = Object.entries(lock.importers[WEB_IMPORTER]?.dependencies ?? {})
  .filter(([name]) => name.startsWith("@miragon/"))
  .map(([name, { version }]) => ({
    name,
    snapshot: snapshotKey(name, version),
    peers: requiredPeers(`${name}@${bare(version)}`),
  }));
const renderers = miragonPackages.filter(({ peers }) => peers.length > 0);

/** the snapshot keys of apps/web's dependencies and those of the workspace packages it links */
function shippedRoots(): string[] {
  const roots: string[] = [];
  const visitedImporters = new Set<string>();
  const visitImporter = (path: string): void => {
    if (visitedImporters.has(path)) return;
    visitedImporters.add(path);
    const importer = lock.importers[path];
    assert.ok(importer, `the lockfile has the importer ${path}`);
    for (const [name, { version }] of Object.entries({ ...importer.dependencies, ...importer.optionalDependencies })) {
      if (version.startsWith("link:")) visitImporter(posix.join(path, version.slice("link:".length)));
      else roots.push(snapshotKey(name, version));
    }
  };
  visitImporter(WEB_IMPORTER);
  return roots;
}

/** the snapshot keys of everything these snapshots reach, themselves included, one per package copy */
function reachableCopies(roots: string[]): string[] {
  const copies = new Set<string>();
  const pending = [...roots];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (copies.has(key)) continue;
    copies.add(key);
    const snapshot = lock.snapshots[key];
    assert.ok(snapshot, `the lockfile has the snapshot ${key}`);
    for (const [name, version] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) {
      pending.push(snapshotKey(name, version));
    }
  }
  return [...copies];
}

test("apps/web pins every peer of its Miragon packages exactly, at the version they draw with", () => {
  assert.ok(renderers.length > 0, "apps/web takes Miragon renderers with peers");
  for (const { name, snapshot, peers } of renderers) {
    const resolved = lock.snapshots[snapshot]?.dependencies ?? {};
    for (const peer of peers) {
      const drawnWith = resolved[peer];
      assert.equal(
        web.dependencies[peer],
        drawnWith && bare(drawnWith),
        `apps/web declares ${peer} as an exact dependency: ${name} takes it as a peer`,
      );
    }
  }
});

const sharedRuntimes = new Set([
  "diagram-js",
  "didi",
  "tiny-svg",
  "zod",
  "@miragon/modeler-api",
  ...miragonPackages.flatMap(({ peers }) => peers),
]);
const sharedWithDiagramJs = new Set(["didi", "tiny-svg"]);
const shipped = reachableCopies(shippedRoots());
const reachedByRenderers = reachableCopies(renderers.map(({ snapshot }) => snapshot));

const followsDiagramJs = (runtime: string): string =>
  `${runtime} follows diagram-js: apps/web pins the ${runtime} diagram-js depends on, ` +
  `so move the pin only in the PR of a diagram-js release on a new ${runtime}`;
/** what moves with a runtime in one PR, where Dependabot opens separate ones (.github/dependabot.yml) */
const movesWith: Record<string, string> = {
  "diagram-js": "bpmn-js and dmn-js depend on diagram-js: move their releases on it in the same PR",
  didi: followsDiagramJs("didi"),
  "tiny-svg": followsDiagramJs("tiny-svg"),
  "@miragon/modeler-api":
    "every Miragon renderer pins the contract exactly: move the renderers, apps/web and packages/live-client in one PR",
};

for (const runtime of sharedRuntimes) {
  const [scope, copies]: [string, string[]] = sharedWithDiagramJs.has(runtime)
    ? ["the Miragon renderers and their diagram-js draw with", reachedByRenderers]
    : ["apps/web ships", shipped];
  test(`${scope} one copy of ${runtime}`, () => {
    const copiesOfRuntime = copies.filter((key) => packageName(key) === runtime);
    assert.equal(
      copiesOfRuntime.length,
      1,
      `${scope} ${copiesOfRuntime.join(", ") || `no ${runtime}`}; ` +
        `\`pnpm why --prod --filter @designiq/web ${runtime}\` names what brings each copy` +
        (movesWith[runtime] ? `; ${movesWith[runtime]}` : ""),
    );
  });
}
