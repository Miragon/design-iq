/**
 * The preferences and the agent's key on disk, in the app's data folder. The
 * preferences are written a moment after the last change (typing in the
 * glossary changes them with every key), always whole: a new file is renamed
 * over the old one.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { checkPreferences, type Preferences, readPreferences } from "../core/preferences.ts";

const WRITE_AFTER_MS = 300;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeWhole(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.part`;
  await writeFile(part, text, { mode });
  await rename(part, path);
}

export class PreferenceStore {
  readonly #path: string;
  #preferences: Preferences;
  #timer: NodeJS.Timeout | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string, defaultFolder: string) {
    this.#path = join(dataDir, "preferences.json");
    this.#preferences = readPreferences(readJson(this.#path), defaultFolder);
  }

  get(): Preferences {
    return this.#preferences;
  }

  /** takes what fits of `change` and answers the preferences as they are now */
  update(change: unknown): Preferences {
    this.#preferences = { ...this.#preferences, ...checkPreferences(change) };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), WRITE_AFTER_MS);
    return this.#preferences;
  }

  /** writes the preferences at once, when Beluga quits: no timer runs after that */
  flushSync(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      writeFileSync(`${this.#path}.part`, `${JSON.stringify(this.#preferences, null, 2)}\n`);
      renameSync(`${this.#path}.part`, this.#path);
    } catch (error) {
      console.error(`preferences not saved: ${(error as Error).message}`);
    }
  }

  /** writes what changed now */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const text = `${JSON.stringify(this.#preferences, null, 2)}\n`;
    this.#writing = this.#writing
      .then(() => writeWhole(this.#path, text))
      .catch((error: unknown) => console.error(`preferences not saved: ${(error as Error).message}`));
    return this.#writing;
  }
}

/** the key an agent needs, readable for this user only; made on first use */
export class AgentKey {
  readonly #path: string;
  #key: string | null = null;

  constructor(dataDir: string) {
    this.#path = join(dataDir, "agent-key");
  }

  async get(): Promise<string> {
    if (!this.#key) {
      const stored = (readJson(this.#path) as { key?: unknown } | null)?.key;
      if (typeof stored === "string" && stored.length >= 32) this.#key = stored;
      else await this.renew();
    }
    return this.current();
  }

  /** the key as it is now, for each request; empty before it was made, which matches no request */
  current(): string {
    return this.#key ?? "";
  }

  async renew(): Promise<void> {
    const key = randomBytes(32).toString("base64url");
    await writeWhole(this.#path, `${JSON.stringify({ key })}\n`, 0o600);
    this.#key = key;
  }
}
