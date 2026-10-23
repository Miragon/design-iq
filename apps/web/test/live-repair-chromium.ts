/**
 * The live merge repair and its notice (issue 296) with real peers, in
 * headless Chromium: a check run by hand, not by `pnpm test`, because CI has
 * no browser. The live-client suites pin the engine on Y.Docs; this one shows
 * what two SPA tabs, a Live Host and a modeler widget make of it. Run it after
 * a change to the canvas sync, the live session or the notice, from the
 * repository root:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/live-repair-chromium.ts"
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8392 unless set)
 * on a generated content repo, one copy of the example order-to-cash process
 * per scenario, and a headless guest session per room that reads the canvas
 * write log and counts the repairs. Each scenario names what it checks:
 *
 *  - drop: two tabs drop moves of different tasks at the same moment; the
 *    merge is malformed, one writer repairs, nobody sees the notice.
 *  - leave: the same, and the writer every peer ranks first closes its tab
 *    before its settle delay ends; the other one repairs.
 *  - blip: one tab's link drops and comes back, then both move a task by
 *    keyboard at the same moment; one repair, one conflict toast.
 *  - notice: a typist leaves half a tag in the source view; the canvas tabs
 *    are told after the notice delay, with Show source; it goes once the
 *    text renders.
 *  - reload: a canvas tab reloads during such a break; it opens on the XML
 *    view with the import-failed toast.
 *  - widget: the same break with the BPMN modeler widget live behind a
 *    minimal MCP-Apps host; it shows the notice with Open in designIQ.
 *
 * ONLY=<scenario>,… runs some of them; SHOTS=<dir> keeps a screenshot of each
 * notice. Exits 1 on any failed check.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CANVAS_LOSSES_KEY, CANVAS_WRITES_KEY } from "@designiq/contracts/live";
import { openLiveSession, roomName } from "@designiq/live-client";

/** the part of Playwright's API this check uses: Playwright is no dependency of the repo */
interface Locator {
  click(): Promise<void>;
  count(): Promise<number>;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  getByRole(role: string, options?: { name?: string }): Locator;
}
interface WebSocketRoute {
  connectToServer(): WebSocketRoute;
  close(): Promise<void>;
}
interface Frame {
  url(): string;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
  locator(selector: string, options?: { hasText?: string }): Locator;
}
interface Page extends Frame {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  getByRole(role: string, options?: { name?: string }): Locator;
  frames(): Frame[];
  mouse: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
  keyboard: { press(key: string): Promise<void>; type(text: string, options?: { delay?: number }): Promise<void> };
  context(): BrowserContext;
  screenshot(options: { path: string }): Promise<unknown>;
  on(event: "pageerror", listener: (error: Error) => void): void;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  routeWebSocket(url: RegExp, handler: (ws: WebSocketRoute) => void): Promise<void>;
  exposeBinding(name: string, binding: (source: unknown, arg: string) => unknown): Promise<void>;
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
}
interface Route {
  request(): { url(): string };
  continue(): Promise<void>;
  fulfill(response: { status?: number; contentType?: string; body?: string }): Promise<void>;
}
interface Playwright {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newContext(options: { viewport: { width: number; height: number } }): Promise<BrowserContext>;
      close(): Promise<void>;
    }>;
  };
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const PORT = Number(process.env.PORT ?? 8392);
const BASE = `http://localhost:${PORT}`;
const REPO = "acme/live-repair";
const SHOTS = process.env.SHOTS;
const NOTICE = "The shared text cannot be rendered. Your canvas shows the last good state.";
const CONFLICT = /crossed a colleague|same element at the same moment/;
/** the fake MCP-Apps host and the widget: answered by this check, never on the
 *  network. Same site as the Live Host (other ports), which a LIVE_AUTH=none
 *  host admits to a room without the ticket a real host mints */
const MCP_HOST = `http://localhost:${PORT + 1}`;
const WIDGET_ORIGIN = `http://localhost:${PORT + 2}`;
const SCENARIOS = ["drop", "leave-early", "leave-late", "blip", "notice", "reload", "widget"] as const;
type Scenario = (typeof SCENARIOS)[number];

/** the one npx puts on PATH */
function loadPlaywright(): Playwright {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = join(dir, "playwright");
    if (existsSync(bin)) return createRequire(realpathSync(bin))("playwright") as Playwright;
  }
  throw new Error('No playwright on PATH: run this through npx -p playwright@1.56.1 -c "node …" (see its header).');
}

function writeContentRepo(dir: string): void {
  mkdirSync(join(dir, "processes"), { recursive: true });
  writeFileSync(join(dir, "designiq.yml"), "models: processes\n");
  const process = readFileSync(join(ROOT, "process-documentation/processes/order-to-cash.bpmn"), "utf8");
  for (const scenario of SCENARIOS) writeFileSync(join(dir, "processes", `${scenario}.bpmn`), process);
}

async function startLiveHost(content: string, data: string): Promise<ChildProcess> {
  const host = spawn(process.execPath, [join(ROOT, "apps/live-host/src/server.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      LIVE_PUBLIC_URL: BASE,
      GITHUB_REPO: REPO,
      LIVE_HOST_CONTENT_DIR: content,
      LIVE_DATA_DIR: data,
      LIVE_AUTH: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  host.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  host.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && host.exitCode === null;) {
    const up = await fetch(`${BASE}/`).then(
      (res) => res.ok,
      () => false,
    );
    if (up) return host;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  host.kill();
  throw new Error(`The Live Host did not start on ${BASE}:\n${log}`);
}

const pathOf = (scenario: Scenario): string => `processes/${scenario}.bpmn`;
const content = async (scenario: Scenario): Promise<string> => {
  const res = await fetch(`${BASE}/api/repos/${REPO}/content?path=${encodeURIComponent(pathOf(scenario))}`);
  return ((await res.json()) as { content: string }).content;
};

/** a headless peer of the room: the canvas write log, ranked as model-sync ranks it, and the repairs */
async function guest(scenario: Scenario) {
  const session = openLiveSession({
    url: `ws://localhost:${PORT}`,
    room: roomName(REPO, pathOf(scenario)),
    token: "x",
  });
  await session.whenSynced(15_000);
  const writes = session.doc.getMap<{ n: number; time: number; held: Record<string, [number, number]> }>(
    CANVAS_WRITES_KEY,
  );
  const repairs: number[] = [];
  session.doc.getMap(CANVAS_LOSSES_KEY).observe((event) => {
    if (![...event.changes.keys.values()].some((change) => change.action !== "delete")) return;
    const { beforeState, afterState } = event.transaction;
    for (const [client, clock] of afterState) if (clock > (beforeState.get(client) ?? 0)) repairs.push(client);
  });
  return {
    session,
    repairs,
    /** the open writes, the repairer first (stand-downs and presence aside) */
    ranked(): number[] {
      const log = [...writes.entries()].filter(([, w]) => typeof w?.n === "number");
      const open = log.filter(([key, w]) => log.every(([other, o]) => other === key || (o.held[key]?.[0] ?? 0) < w.n));
      const holds = (w: { n: number; held: Record<string, [number, number]> }): number =>
        Object.values(w.held).reduce((sum, [n]) => sum + n, w.n);
      open.sort(([a, x], [b, y]) => y.time - x.time || holds(y) - holds(x) || Number(a) - Number(b));
      return open.map(([key]) => Number(key));
    },
  };
}

const failures: string[] = [];
const results: Array<{ scenario: string; check: string; ok: boolean; detail: string }> = [];
function check(scenario: string, name: string, ok: boolean, detail = ""): void {
  results.push({ scenario, check: name, ok, detail: detail.slice(0, 80) });
  if (!ok) failures.push(`${scenario}: ${name}${detail ? ` (${detail})` : ""}`);
}

const CANVAS = ".bpmn-canvas .djs-element";
const shape = (id: string): string => `${CANVAS}[data-element-id="${id}"]`;
const CREDIT = "Task_check_credit";
const INQUIRY = "Task_handle_inquiry";

const playwright = loadPlaywright();
for (const file of ["index.html", "mcp-app.html"]) {
  if (!existsSync(join(DIST, file))) throw new Error(`apps/web/dist/${file} is missing: run pnpm build first.`);
}
const work = mkdtempSync(join(tmpdir(), "designiq-live-repair-"));
writeContentRepo(join(work, "content"));
const host = await startLiveHost(join(work, "content"), join(work, "data"));
const browser = await playwright.chromium.launch({ headless: true });
const pageErrors: string[] = [];

const newContext = (): Promise<BrowserContext> => browser.newContext({ viewport: { width: 1440, height: 900 } });
/** a tab of its own browser context: its own session, as another person's */
async function tab(context?: BrowserContext): Promise<Page> {
  const page = await (context ?? (await newContext())).newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  return page;
}
async function open(page: Page, scenario: Scenario): Promise<Page> {
  await page.goto(`${BASE}/r/${REPO}/f/${pathOf(scenario)}`);
  await page.waitForSelector(shape(CREDIT), { timeout: 30_000 });
  await page.waitForTimeout(1500);
  return page;
}
const toasts = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent?.trim() ?? ""), 0);
const notices = async (page: Page): Promise<number> => (await toasts(page)).filter((t) => t.includes(NOTICE)).length;
const conflicts = async (page: Page): Promise<number> => (await toasts(page)).filter((t) => CONFLICT.test(t)).length;
const wellFormed = (page: Page, text: string): Promise<boolean> =>
  page.evaluate((t) => !new DOMParser().parseFromString(t, "application/xml").querySelector("parsererror"), text);
const transform = (page: Page, id: string): Promise<string | null> =>
  page.evaluate((selector) => document.querySelector(selector)?.getAttribute("transform") ?? null, shape(id));
const sourceShown = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const source = document.querySelector(".monaco-host");
    return source ? !source.hasAttribute("inert") : false;
  }, 0);
const views = (page: Page): Locator => page.getByRole("group", { name: "Editor view" }).getByRole("button");
async function center(page: Page, id: string): Promise<{ x: number; y: number }> {
  const at = await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    const box = (element?.querySelector(".djs-hit") ?? element)?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  }, shape(id));
  if (!at) throw new Error(`${id} is not on the canvas`);
  return at;
}
/** press on a task and drag it, the drop left for the caller: two drops can then land at once */
async function grab(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const at = await center(page, id);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx, at.y + dy, { steps: 8 });
}
/** once the toast's entrance is over */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
/** a typist leaves half a tag in the source view: a break no repair writes over */
async function typeHalfTag(typist: Page): Promise<void> {
  await views(typist).last().click();
  await typist.waitForSelector(".monaco-editor .view-line", { timeout: 15_000 });
  await typist.waitForTimeout(500);
  await typist.locator(".monaco-editor .view-line").nth(5).click();
  await typist.keyboard.press("End");
  await typist.keyboard.press("Enter");
  await typist.keyboard.type('<bpmn:message id="Message_halftyped', { delay: 20 });
}

/** two writers drop moves at once; returns the moves' starting points */
async function crossingDrops(a: Page, b: Page): Promise<{ credit: string | null; inquiry: string | null }> {
  const before = { credit: await transform(a, CREDIT), inquiry: await transform(a, INQUIRY) };
  await grab(a, CREDIT, 50, 40);
  await grab(b, INQUIRY, 45, -30);
  await Promise.all([a.mouse.up(), b.mouse.up()]);
  return before;
}

/** after a repair: the room renders, both canvases show it, exactly one of the two moves stays */
async function repairedOnce(
  scenario: Scenario,
  pages: Page[],
  before: { credit: string | null; inquiry: string | null },
) {
  const text = await content(scenario);
  check(scenario, "the shared text is well-formed again", await wellFormed(pages[0]!, text), `${text.length} bytes`);
  const credit = await Promise.all(pages.map((p) => transform(p, CREDIT)));
  const inquiry = await Promise.all(pages.map((p) => transform(p, INQUIRY)));
  check(scenario, "every canvas shows the same state", new Set(credit).size === 1 && new Set(inquiry).size === 1);
  const kept = { credit: credit[0] !== before.credit, inquiry: inquiry[0] !== before.inquiry };
  check(scenario, "exactly one move stays", kept.credit !== kept.inquiry, JSON.stringify(kept));
}

async function drop(): Promise<void> {
  const g = await guest("drop");
  const [a, b] = [await open(await tab(), "drop"), await open(await tab(), "drop")];
  const before = await crossingDrops(a, b);
  await a.waitForTimeout(400);
  check("drop", "precondition: the merge is malformed", !(await wellFormed(a, await content("drop"))));
  let noticed = 0;
  for (const until = Date.now() + 9000; Date.now() < until; await a.waitForTimeout(200)) {
    noticed += (await notices(a)) + (await notices(b));
  }
  await repairedOnce("drop", [a, b], before);
  check("drop", "one repair", g.repairs.length === 1, JSON.stringify(g.repairs));
  check("drop", "no notice during a repair", noticed === 0);
  g.session.destroy();
  for (const p of [a, b]) await p.context().close();
}

async function leave(scenario: "leave-early" | "leave-late", closeAfterMs: number): Promise<void> {
  const g = await guest(scenario);
  const a = await open(await tab(), scenario);
  const b = await open(await tab(), scenario);
  // the writers' client ids, in the order of their first write
  await grab(a, CREDIT, 50, 40);
  await a.mouse.up();
  await a.waitForTimeout(2500);
  const idA = g.ranked()[0];
  const before = { credit: await transform(b, CREDIT), inquiry: await transform(b, INQUIRY) };
  await grab(a, CREDIT, 50, 40);
  await grab(b, INQUIRY, 45, -30);
  await Promise.all([a.mouse.up(), b.mouse.up()]);
  const dropped = Date.now();
  let ranked: number[] = [];
  while (ranked.length < 2 && Date.now() - dropped < 1000) {
    ranked = g.ranked();
    await a.waitForTimeout(25);
  }
  check(scenario, "precondition: the drops crossed (two open writes)", ranked.length >= 2, JSON.stringify(ranked));
  const [first, other] = ranked[0] === idA ? [a, b] : [b, a];
  const wait = closeAfterMs - (Date.now() - dropped);
  if (wait > 0) await first.waitForTimeout(wait);
  await first.context().close();
  const closedAt = Date.now() - dropped;
  await other.waitForTimeout(6000);
  await repairedOnce(scenario, [other], before);
  const otherMove = other === a ? CREDIT : INQUIRY;
  check(
    scenario,
    `the remaining writer repaired with its own move (tab closed ${closedAt} ms after the drop)`,
    (await transform(other, otherMove)) !== (other === a ? before.credit : before.inquiry),
  );
  check(scenario, "the remaining writer sees no notice", (await notices(other)) === 0);
  const fresh = await tab();
  let rendered = true;
  await fresh.goto(`${BASE}/r/${REPO}/f/${pathOf(scenario)}`);
  await fresh.waitForSelector(shape(CREDIT), { timeout: 15_000 }).catch(() => (rendered = false));
  check(
    scenario,
    "a fresh tab renders the room",
    rendered && !(await toasts(fresh)).some((t) => /import failed/i.test(t)),
  );
  g.session.destroy();
  for (const p of [other, fresh]) await p.context().close();
}

async function blip(): Promise<void> {
  const g = await guest("blip");
  const a = await open(await tab(), "blip");
  const context = await newContext();
  let link: { page: WebSocketRoute; server: WebSocketRoute } | undefined;
  await context.routeWebSocket(/.*/, (ws) => {
    link = { page: ws, server: ws.connectToServer() };
  });
  const b = await open(await tab(context), "blip");
  await a.locator(shape(CREDIT)).first().click();
  await b.locator(shape(INQUIRY)).first().click();
  const before = { credit: await transform(a, CREDIT), inquiry: await transform(a, INQUIRY) };
  const old = link;
  await old?.server.close();
  await old?.page.close();
  for (const until = Date.now() + 10_000; link === old && Date.now() < until;) await b.waitForTimeout(100);
  check("blip", "precondition: b's link dropped and came back", link !== undefined && link !== old);
  await b.waitForTimeout(1500);
  await Promise.all([a.keyboard.press("Shift+ArrowRight"), b.keyboard.press("Shift+ArrowDown")]);
  let most = 0;
  for (const until = Date.now() + 10_000; Date.now() < until; await a.waitForTimeout(200)) {
    most = Math.max(most, (await conflicts(a)) + (await conflicts(b)));
  }
  await repairedOnce("blip", [a, b], before);
  check("blip", "one repair: every peer names the same repairer", g.repairs.length === 1, JSON.stringify(g.repairs));
  check("blip", "one conflict toast, for the writer whose move was lost", most === 1, `${most}`);
  g.session.destroy();
  for (const p of [a, b]) await p.context().close();
}

async function notice(): Promise<void> {
  const typist = await open(await tab(), "notice");
  const a = await open(await tab(), "notice");
  const b = await open(await tab(), "notice");
  await typeHalfTag(typist);
  const typed = Date.now();
  check("notice", "precondition: the shared text is half-typed", !(await wellFormed(a, await content("notice"))));
  await a.waitForTimeout(3000);
  check("notice", "3 s in: no notice yet, a repair could still come", (await notices(a)) + (await notices(b)) === 0);
  let toldAfter = -1;
  for (const until = typed + 9000; Date.now() < until; await a.waitForTimeout(150)) {
    if ((await notices(a)) > 0 && (await notices(b)) > 0) {
      toldAfter = Date.now() - typed;
      break;
    }
  }
  check("notice", "both canvas tabs are told", toldAfter > 0, `${toldAfter} ms after the typing`);
  await shot(a, "notice-canvas");
  check("notice", "the typist, in the source view, is not", (await notices(typist)) === 0);
  const action = a.locator("[data-sonner-toast]", { hasText: NOTICE }).getByRole("button", { name: "Show source" });
  check("notice", "the notice offers Show source", (await action.count()) === 1);
  if ((await action.count()) === 1) {
    await action.click();
    await a.waitForTimeout(700);
    check(
      "notice",
      "Show source opens the source, the notice goes",
      (await sourceShown(a)) && (await notices(a)) === 0,
    );
    await views(a).first().click();
    await a.waitForTimeout(700);
    check("notice", "back on the canvas while it is still broken, the notice is back", (await notices(a)) === 1);
  }
  await typist.keyboard.type('" />', { delay: 20 });
  await typist.waitForTimeout(2500);
  check("notice", "the finished tag renders", await wellFormed(a, await content("notice")));
  check("notice", "the notice goes on every canvas tab", (await notices(a)) + (await notices(b)) === 0);
  for (const p of [typist, a, b]) await p.context().close();
}

async function reload(): Promise<void> {
  const typist = await open(await tab(), "reload");
  const a = await open(await tab(), "reload");
  await typeHalfTag(typist);
  for (const until = Date.now() + 9000; (await notices(a)) === 0 && Date.now() < until;) await a.waitForTimeout(150);
  check("reload", "precondition: the canvas tab is told", (await notices(a)) === 1);
  await a.reload();
  let failed = "";
  for (const until = Date.now() + 15_000; !failed && Date.now() < until; await a.waitForTimeout(100)) {
    failed = (await toasts(a)).find((t) => /import failed/i.test(t)) ?? "";
  }
  check("reload", "after the reload, the import-failed toast", failed !== "", failed);
  await shot(a, "reload-source");
  check("reload", "after the reload, the XML view", await sourceShown(a));
  for (const p of [typist, a]) await p.context().close();
}

/** the MCP-Apps host the widget talks to: initialize, the tool input, the tools it calls */
const MCP_HOST_PAGE = `<!doctype html><html><body style="margin:0"><iframe id="w" style="width:900px;height:640px;border:0"></iframe><script>
const frame = document.getElementById("w");
const post = (msg) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...msg }, "*");
window.addEventListener("message", async (e) => {
  if (e.source !== frame.contentWindow || e.data?.jsonrpc !== "2.0") return;
  const m = e.data;
  if (m.method === "ui/initialize") {
    post({ id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: "live-repair-check", version: "1.0.0" },
      hostCapabilities: { serverTools: {}, openLinks: {}, logging: {} },
      hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: 900, maxHeight: 640 } } } });
  } else if (m.method === "ui/notifications/initialized") {
    post({ method: "ui/notifications/tool-input", params: { arguments: window.__args } });
    post({ method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: JSON.stringify({ opened: window.__args }) }] } });
  } else if (m.method === "tools/call") {
    post({ id: m.id, result: JSON.parse(await window.__tool(JSON.stringify(m.params))) });
  } else if (m.id !== undefined) {
    post({ id: m.id, result: {} });
  }
});
</script></body></html>`;

async function widget(): Promise<void> {
  const path = pathOf("widget");
  const context = await newContext();
  await context.exposeBinding("__tool", async (_source, params) => {
    const { name } = JSON.parse(params) as { name: string };
    const answer = (wire: unknown) => JSON.stringify({ content: [{ type: "text", text: JSON.stringify(wire) }] });
    if (name === "get_model_content") {
      return answer(await (await fetch(`${BASE}/api/repos/${REPO}/content?path=${encodeURIComponent(path)}`)).json());
    }
    if (name === "mint_ws_ticket") {
      return answer({ ticket: "x", url: `ws://localhost:${PORT}`, room: roomName(REPO, path), expiresInSeconds: 60 });
    }
    return JSON.stringify({ isError: true, content: [{ type: "text", text: `${name} is not offered here` }] });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === MCP_HOST) return route.fulfill({ contentType: "text/html", body: MCP_HOST_PAGE });
    if (url.origin === WIDGET_ORIGIN) {
      const boot = JSON.stringify(JSON.stringify({ readonly: false, publicUrl: BASE }));
      const html = readFileSync(join(DIST, "mcp-app.html"), "utf8").replace('"__DESIGNIQ_BOOT__"', () => boot);
      return route.fulfill({ contentType: "text/html", body: html });
    }
    return route.continue();
  });
  const page = await tab(context);
  await page.goto(`${MCP_HOST}/host.html`);
  await page.evaluate(
    ({ args, src }) => {
      Object.assign(window, { __args: args });
      document.querySelector("iframe")!.src = src;
    },
    { args: { repo: REPO, path }, src: `${WIDGET_ORIGIN}/mcp-app.html` },
  );
  const inWidget = (): Frame | undefined => page.frames().find((f) => f.url().startsWith(WIDGET_ORIGIN));
  const text = async (): Promise<string> =>
    (await inWidget()?.evaluate(() => document.body.innerText.replace(/\s+/g, " "), 0)) ?? "";
  for (const until = Date.now() + 20_000; !(await text()).includes("Live") && Date.now() < until;) {
    await page.waitForTimeout(250);
  }
  check("widget", "precondition: the widget is live", (await text()).includes("Live"));
  const typist = await open(await tab(), "widget");
  await typeHalfTag(typist);
  for (const until = Date.now() + 9000; !(await text()).includes(NOTICE) && Date.now() < until;) {
    await page.waitForTimeout(150);
  }
  const lane = async (): Promise<string[]> =>
    (await inWidget()?.evaluate(
      () => [...document.querySelectorAll(".toast")].map((t) => t.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      0,
    )) ?? [];
  const told = (await lane()).find((t) => t.includes(NOTICE)) ?? "";
  check("widget", "the widget is told", told !== "", told);
  check("widget", "with Open in designIQ", told.includes("Open in designIQ"));
  await shot(page, "widget-notice");
  await typist.keyboard.type('" />', { delay: 20 });
  for (const until = Date.now() + 5000; (await lane()).some((t) => t.includes(NOTICE)) && Date.now() < until;) {
    await page.waitForTimeout(150);
  }
  check("widget", "the notice goes once the text renders", !(await lane()).some((t) => t.includes(NOTICE)));
  for (const p of [typist, page]) await p.context().close();
}

const RUN: Record<Scenario, () => Promise<void>> = {
  drop,
  "leave-early": () => leave("leave-early", 50),
  "leave-late": () => leave("leave-late", 1150),
  blip,
  notice,
  reload,
  widget,
};
const only = process.env.ONLY?.split(",");
try {
  for (const scenario of SCENARIOS) if (!only || only.includes(scenario)) await RUN[scenario]();
  check("all", "no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  console.table(results);
} finally {
  await browser.close();
  host.kill();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} checks passed.`);
