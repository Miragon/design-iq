/**
 * Symlink guards for the filesystem paths of a workspace: lexical path checks
 * are blind to symlinks — a previously created folder could be replaced by a
 * link pointing outside, and a write would then land through it.
 *
 * assertRealInsideWorkspace guards the scaffolding writes: canonicalize the
 * nearest EXISTING ancestor (that is where the write physically lands) and
 * require it to stay inside the canonical workspace. Was a verbatim private
 * copy in scaffold.ts and decision-tests.ts; the wire-visible error code stays
 * per caller.
 *
 * modelFileRefusal guards every read and write of a model file, below.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { AppError } from "@designiq/http-kit";

export function assertRealInsideWorkspace(
  target: string,
  workspace: string,
  what: string,
  code: "scaffold/outside-processes-root" | "decision-tests/outside-workspace",
): void {
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const realWorkspace = realpathSync(workspace);
  if (real !== realWorkspace && !real.startsWith(realWorkspace + sep)) {
    throw new AppError(code, `${what} escapes the workspace (symlink)`, {
      status: 400,
      expose: true,
    });
  }
}

/**
 * The ONE guard of a model file's path, wherever it is read or written: the
 * room's load and write-through (collab.ts resolveRoom), the REST/MCP content
 * routes (content.ts assertOnDisk) and the repair of a file the room refuses
 * (content.ts saveOverUnreadable). toDiskPath keeps a room lexically inside
 * the models folder, but a symlink a pull request brought into the checkout
 * would still lead the read and the write anywhere in it, .git/config
 * included (whose core.fsmonitor git runs on the host's next fetch or
 * reset). So:
 *   - the model file itself is no symlink and, when it exists, a regular file
 *     (discoverModels lists only regular files, so no model is lost)
 *   - where it physically lands (the file, or its nearest existing folder when
 *     a write-through recreates it) lies inside the real workspace and the
 *     real models folder, which may itself be a link inside the workspace
 *   - and in no .git folder, even when the models folder is a link into one
 * `modelsFolder` is the content config's folder (repo-relative). Undefined
 * when the path is safe, else why not ("is a symlink"); each caller throws
 * its own error, a typed one on REST, a plain one on the ws path.
 */
export function modelFileRefusal(disk: string, workspace: string, modelsFolder: string): string | undefined {
  let file: ReturnType<typeof lstatSync>;
  try {
    file = lstatSync(disk, { throwIfNoEntry: false });
  } catch (err) {
    // a folder on the way that is a file (order.md/x.md) or a link loop: no
    // such model, which the callers answer as they answer a missing file, not
    // a raw errno that names the host's absolute path
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOTDIR" && code !== "ELOOP") throw err;
    file = undefined;
  }
  if (file?.isSymbolicLink()) return "is a symlink";
  if (file && !file.isFile()) return "is not a regular file";
  let probe = disk;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const realWorkspace = realpathSync(workspace);
  if (real !== realWorkspace && !real.startsWith(realWorkspace + sep)) {
    return "leaves the workspace through a symlink";
  }
  if (relative(realWorkspace, real).split(sep).includes(".git")) return "leads into .git through a symlink";
  const models = resolve(workspace, modelsFolder);
  // no models folder: no file in it either, nothing to read, and a write
  // cannot land (writeFile creates no folders)
  if (!existsSync(models)) return undefined;
  const realModels = realpathSync(models);
  if (real !== realModels && !real.startsWith(realModels + sep)) {
    return "leaves the models folder through a symlink";
  }
  return undefined;
}
