/**
 * The boot check of the data directory (LIVE_DATA_DIR, #3). The image runs as an
 * unprivileged user, while a volume written by an image up to 5.13.3 (those ran as root)
 * and a bind-mount directory the Docker daemon created belong to root. SQLite opens a
 * live.db it cannot write read-only without a word: a standalone host then dies at its
 * first write during the boot, a cell boots and fails every edit. server.ts stops before
 * that, with this message.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** what the Live Host writes below its data directory: SQLite with its journals, the clones */
const WRITTEN_ENTRIES = ["live.db", "live.db-journal", "live.db-wal", "live.db-shm", "workspaces"];

export interface ProcessIds {
  uid: number;
  gid: number;
}

export function processIds(): ProcessIds | undefined {
  return process.getuid && process.getgid ? { uid: process.getuid(), gid: process.getgid() } : undefined;
}

/** the message to stop the boot with when this process cannot write `dataDir`, else undefined */
export function dataDirProblem(dataDir: string, ids: ProcessIds | undefined = processIds()): string | undefined {
  const self = ids ? `${ids.uid}:${ids.gid}` : "<uid>:<gid>";
  const runsAs = ids ? `the Live Host runs as ${self} (uid:gid)` : "the Live Host's user cannot write it";
  if (!existsSync(dataDir)) {
    const parent = nearestExisting(dirname(dataDir));
    if (!writeError(parent)) return undefined;
    return [
      `designIQ cannot create its data directory ${dataDir}: ${parent} belongs to ${owner(parent).ids}, and ${runsAs}.`,
      "Create it once, as root, and hand it over:",
      `  mkdir -p ${dataDir} && chown -R ${self} ${dataDir}`,
    ].join("\n");
  }
  const blocked = [dataDir, ...WRITTEN_ENTRIES.map((name) => join(dataDir, name))]
    .filter((path) => existsSync(path))
    .map((path) => ({ path, error: writeError(path) }))
    .find(({ error }) => error);
  if (!blocked) return undefined;
  if (blocked.error === "EROFS") {
    return `designIQ cannot write its data directory ${dataDir}: ${blocked.path} is on a read-only file system. Mount it read-write.`;
  }
  const { ids: ownerIds, root } = owner(blocked.path);
  return [
    `designIQ cannot write its data directory ${dataDir}: ${blocked.path} belongs to ${ownerIds}, and ${runsAs}.`,
    ...(root
      ? [
          "A volume written by an image up to 5.13.3 (those ran as root) and a bind-mount directory the Docker daemon created belong to root.",
        ]
      : []),
    "Hand the directory over once, as root, with the Live Host stopped:",
    `  chown -R ${self} ${dataDir}`,
    `With Docker Compose: docker compose run --rm --user root live-host chown -R ${self} ${dataDir}`,
    "See docs/on-prem/README.md#upgrades",
  ].join("\n");
}

function nearestExisting(path: string): string {
  return existsSync(path) || dirname(path) === path ? path : nearestExisting(dirname(path));
}

function writeError(path: string): string | undefined {
  try {
    accessSync(path, constants.W_OK);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "EACCES";
  }
}

function owner(path: string): { ids: string; root: boolean } {
  const { uid, gid } = statSync(path);
  return { ids: `${uid}:${gid}`, root: uid === 0 };
}
