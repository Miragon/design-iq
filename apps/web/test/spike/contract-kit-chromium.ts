/**
 * The conformance kit of @miragon/modeler-api against the board module: opens board-spike-kit.html,
 * where src/board-spike/module/kit-main.ts runs every case, and prints each outcome. A case that
 * fails makes the exit code 1; a skipped case and an advisory are printed and counted, never hidden.
 *
 *   PORT=5480 node apps/web/test/spike/contract-kit-chromium.ts
 *   ONLY=L5 PORT=5480 node apps/web/test/spike/contract-kit-chromium.ts     # cases whose name holds "L5"
 */
import { launchBrowser, startServer, writeResult } from "./lib.ts";

interface KitResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  advisories: string[];
  ms: number;
  extra?: true;
}
interface KitReport {
  done: boolean;
  results: KitResult[];
  problems: string[];
}

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 480_000);
const server = await startServer();
const browser = await launchBrowser();
let code = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  const query = new URLSearchParams();
  if (process.env.ONLY) query.set("only", process.env.ONLY);
  // SCOPE=page: the board takes keys from the whole page, as React Flow does by itself (the control run of the keys case)
  if (process.env.SCOPE) query.set("scope", process.env.SCOPE);
  const search = query.size > 0 ? `?${query.toString()}` : "";
  await page.goto(`${server.base}/board-spike-kit.html${search}`);
  const mark = await page.evaluate(() =>
    document.querySelector('meta[name="designiq-spike"]')?.getAttribute("content"),
  );
  if (mark !== "kit") throw new Error(`not the kit page (mark: ${String(mark)})`);
  const started = Date.now();
  let seen = 0;
  for (;;) {
    const report = await page.evaluate(() => (window as unknown as { __boardKit?: KitReport }).__boardKit);
    for (const result of report?.results.slice(seen) ?? []) {
      console.log(`${result.status.padEnd(7)} ${String(result.ms).padStart(6)} ms  ${result.name}`);
      if (result.reason) console.log(`        ${result.reason.replaceAll("\n", "\n        ")}`);
      for (const advice of result.advisories) console.log(`        advisory: ${advice}`);
    }
    seen = report?.results.length ?? 0;
    if (report?.done) {
      const kit = report.results.filter((one) => !one.extra);
      const extras = report.results.filter((one) => one.extra);
      const count = (all: KitResult[], status: KitResult["status"]): number =>
        all.filter((one) => one.status === status).length;
      const advisories = kit.reduce((sum, one) => sum + one.advisories.length, 0);
      console.log(
        `\n${kit.length} cases of the kit: ${count(kit, "passed")} passed, ${count(kit, "failed")} failed, ${count(kit, "skipped")} skipped, ${advisories} advisories`,
      );
      if (extras.length > 0) {
        console.log(
          `${extras.length} checks beyond the kit: ${count(extras, "passed")} passed, ${count(extras, "failed")} failed`,
        );
      }
      if (report.problems.length > 0)
        console.log(`page problems (${report.problems.length}):\n  ${report.problems.join("\n  ")}`);
      if (consoleErrors.length > 0)
        console.log(`console errors (${consoleErrors.length}):\n  ${[...new Set(consoleErrors)].join("\n  ")}`);
      console.log(writeResult("contract-kit", { ...report, consoleErrors }));
      if (count(report.results, "failed") > 0) code = 1;
      break;
    }
    if (Date.now() - started > TIMEOUT_MS) {
      console.error(`the kit did not finish in ${TIMEOUT_MS} ms; ${seen} cases are through`);
      if (consoleErrors.length > 0) console.error(`console errors:\n  ${[...new Set(consoleErrors)].join("\n  ")}`);
      code = 1;
      break;
    }
    await page.waitForTimeout(500);
  }
  const notes = server.optimizerNotes();
  if (notes.length > 0) {
    console.error(`the dev server's optimizer ran again during the run:\n${notes.join("\n")}`);
    code = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  code = 1;
} finally {
  await browser.close();
  await server.close();
}
process.exitCode = code;
setTimeout(() => process.exit(code), 2000).unref();
