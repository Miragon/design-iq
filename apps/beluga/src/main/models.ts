/**
 * Fetching a speech model on first use, file by file. Each file goes to a .part
 * file first and takes its real name only when its size and SHA-256 match, so a
 * broken or interrupted download never looks complete, and a second attempt
 * fetches only what is still missing.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import type { DownloadProgress } from "../core/ipc.ts";
import { type Download, downloads, type ModelId } from "../core/models.ts";
import { missingFiles } from "../engine/files.ts";

type Report = (progress: DownloadProgress) => void;
/** Electron's `net.fetch` in the app: it goes through the system's proxy and trusts the system's certificates */
export type Fetch = (url: string, signal: AbortSignal) => Promise<Response>;

/** a download that receives nothing for this long has stalled */
const STALL_MS = 60_000;

const partOf = (target: string): string => `${target}.part`;

async function fetchFile(
  fetch: Fetch,
  download: Download,
  target: string,
  onBytes: (n: number) => void,
): Promise<void> {
  // the network may go quiet without closing the connection: give up after a minute without data
  const stall = new AbortController();
  const timer = setTimeout(() => stall.abort(), STALL_MS);
  const part = partOf(target);
  const hash = createHash("sha256");
  let received = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      timer.refresh();
      hash.update(chunk);
      received += chunk.length;
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
  try {
    const response = await fetch(download.url, stall.signal);
    if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}): ${download.url}`);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), count, createWriteStream(part));
    if (received !== download.file.bytes || hash.digest("hex") !== download.file.sha256) {
      throw new Error(`${download.file.name} arrived damaged. Please download again.`);
    }
    await rename(part, target);
  } catch (error) {
    await rm(part, { force: true });
    if (stall.signal.aborted) throw new Error("The download received no data for a minute. Please try again.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function installModel(modelsDir: string, model: ModelId, report: Report, fetch: Fetch): Promise<void> {
  const missing = new Set(missingFiles(modelsDir, model));
  const wanted = downloads(model).filter((d) => missing.has(d.path));
  const total = wanted.reduce((sum, d) => sum + d.file.bytes, 0);
  if (total === 0) return;
  await mkdir(modelsDir, { recursive: true });
  // what a download cut short by a quit or a crash left behind (one download runs at a time)
  for (const download of wanted) await rm(partOf(join(modelsDir, ...download.path.split("/"))), { force: true });
  const disk = await statfs(modelsDir);
  const free = disk.bavail * disk.bsize;
  if (free < total) {
    const needed = Math.ceil(total / 1e6);
    throw new Error(`Not enough disk space: the model needs ${needed} MB, ${Math.floor(free / 1e6)} MB are free.`);
  }

  let done = 0;
  let percent = -1;
  const progress = (bytes: number): void => {
    done += bytes;
    const now = Math.floor((done / total) * 100);
    if (now === percent) return;
    percent = now;
    report({ model, fraction: done / total });
  };
  progress(0);
  for (const download of wanted) {
    await fetchFile(fetch, download, join(modelsDir, ...download.path.split("/")), progress);
  }
}
