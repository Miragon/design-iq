/**
 * Repository images for the web client's Markdown view (#290): a relative
 * image in a document (`![](./diagram.png)`) is a file of the repository, and
 * the reader sees it from the Live Host, never from a third party. The route
 * (http/api.ts) authorizes like the content API; this use-case decides which
 * file may go out:
 *   - an image type of REPO_IMAGE_TYPES only, by extension. The response
 *     carries that type with nosniff, so no other file reads as an image;
 *   - the room gate's path rules: no dot segment (.git, .github, .env…), no
 *     node_modules, no empty or parent segment;
 *   - inside the workspace after symlinks resolve: a link in the checkout must
 *     not hand out a file of the host;
 *   - REPO_IMAGE_MAX_BYTES at most.
 * Any image of the repository qualifies, not only those in the models folder:
 * documentation keeps its pictures where it likes, and a person with write
 * access to the repository can read every file of it anyway.
 */
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { REPO_IMAGE_MAX_BYTES, repoImageType } from "@designiq/contracts/live";
import { AppError } from "@designiq/http-kit";

import type { WorkspaceEnsure } from "../domain/rooms.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface RepoImage {
  /** where it is on disk, symlinks resolved */
  diskPath: string;
  /** its MIME type */
  type: string;
  size: number;
  /** a weak validator from size and modification time */
  etag: string;
}

const invalid = (message: string): AppError =>
  new AppError("image/invalid-path", message, { status: 400, expose: true });

/** the image file `path` (repo-relative) names in the repository's workspace, or a typed error */
export async function locateRepoImage(
  deps: { workspaces: WorkspaceEnsure },
  repo: ConnectedRepo,
  path: string,
): Promise<RepoImage> {
  const segments = path.split("/");
  if (path.includes("\0") || segments.some((s) => s === "" || s.startsWith(".") || s === "node_modules")) {
    throw invalid(`not a servable repository path: ${path}`);
  }
  const type = repoImageType(path);
  if (!type) {
    throw new AppError("image/unsupported-type", `not an image the Live Host serves: ${path}`, {
      status: 415,
      expose: true,
    });
  }
  const workspace = await deps.workspaces.ensure(repo);
  const notFound = new AppError("image/not-found", `no such image: ${path} (${repo.fullName})`, {
    status: 404,
    expose: true,
  });
  let diskPath: string;
  try {
    diskPath = realpathSync(resolve(workspace, path));
  } catch {
    throw notFound;
  }
  if (!diskPath.startsWith(realpathSync(workspace) + sep)) throw invalid(`${path} leaves the repository (symlink)`);
  const stats = statSync(diskPath);
  if (!stats.isFile()) throw notFound;
  if (stats.size > REPO_IMAGE_MAX_BYTES) {
    throw new AppError(
      "image/too-large",
      `${path} is larger than the ${REPO_IMAGE_MAX_BYTES / 1024 / 1024} MiB the Live Host serves`,
      { status: 413, expose: true },
    );
  }
  return {
    diskPath,
    type,
    size: stats.size,
    etag: `W/"${stats.size.toString(36)}-${Math.trunc(stats.mtimeMs).toString(36)}"`,
  };
}
