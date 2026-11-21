/**
 * Whether a model's files are all on disk. File system only: the main process
 * asks this without loading the speech engine, which lives in its own process.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import { downloads, type ModelId } from "../core/models.ts";

/** a file counts when it is there at its full size; a download only renames it into place once its checksum matched */
function complete(path: string, bytes: number): boolean {
  try {
    return statSync(path).size === bytes;
  } catch {
    return false;
  }
}

/** the files of a model that are missing or incomplete under `modelsDir`, empty when it is ready */
export function missingFiles(modelsDir: string, model: ModelId): string[] {
  return downloads(model)
    .filter((d) => !complete(join(modelsDir, d.path), d.file.bytes))
    .map((d) => d.path);
}
