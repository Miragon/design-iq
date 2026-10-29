/**
 * Hostile Mermaid sources (issue 293) in the built app, in headless Chromium:
 * a check run by hand, not by `pnpm test` or CI, as it needs a build and a
 * Live Host of its own. The jsdom suites cannot show what a browser does with
 * these sources: that it enforces the Mermaid frame's policy, and that the
 * page's document neither holds nor loads anything of a hostile diagram. Run
 * it after a mermaid or a browser update, from the repository root:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/hostile-mermaid-chromium.ts"
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8391 unless set)
 * on a generated content repo: one Markdown document per hostile label
 * (./mermaid-hostile-sources.ts) in every diagram type, and one with the
 * links, clicks, front matter, directives and foreignObject HTML. It opens
 * each in the SPA and clicks every element of every diagram as a reader
 * could, then opens each in the BPMN and DMN widgets behind a minimal
 * MCP-Apps host: they draw no Mermaid, but take any path. Positive controls
 * show that what it watches for would be seen. Exits 1 on anything that ran
 * or loaded.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHAPE_IMAGE_FROM_ADDRESS } from "../src/lib/mermaid-render.ts";
import { FEATURES, LABELS, SOURCES, TRACKER } from "./mermaid-hostile-sources.ts";

/** the part of Playwright's API this check uses: Playwright is no dependency of the repo */
interface Request {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): Frame;
  allHeaders(): Promise<Record<string, string>>;
}
interface Route {
  request(): Request;
  continue(): Promise<void>;
  fulfill(response: { status?: number; contentType?: string; body?: string }): Promise<void>;
}
interface Frame {
  url(): string;
  page(): Page;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
}
interface Page extends Frame {
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
  frames(): Frame[];
  mainFrame(): Frame;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options: { timeout: number; polling?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: "dialog", listener: (dialog: { message(): string; dismiss(): Promise<void> }) => void): void;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  exposeBinding(name: string, binding: (source: { frame: Frame }, arg: string) => unknown): Promise<void>;
  addInitScript<A>(script: (arg: A) => void, arg: A): Promise<void>;
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  on(event: "page", listener: (page: Page) => void): void;
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
const PORT = Number(process.env.PORT ?? 8391);
const BASE = `http://localhost:${PORT}`;
const REPO = "acme/hostile";
const WIDGETS = ["mcp-app.html", "mcp-app-dmn.html"];
/** the fake MCP-Apps host and the widgets' origin: answered by this check, never on the network */
const MCP_HOST = "http://mcp-host.test";
const WIDGET_ORIGIN = "http://widget.test";

/** the one npx puts on PATH */
function loadPlaywright(): Playwright {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = join(dir, "playwright");
    if (existsSync(bin)) return createRequire(realpathSync(bin))("playwright") as Playwright;
  }
  throw new Error('No playwright on PATH: run this through npx -p playwright@1.56.1 -c "node …" (see its header).');
}

interface HostileDocument {
  file: string;
  title: string;
  fences: { name: string; source: string }[];
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function hostileDocuments(): HostileDocument[] {
  const documents = Object.entries(LABELS).map(([label, payload]) => ({
    file: `label-${slug(label)}.md`,
    title: `Hostile label: ${slug(label)}`,
    fences: Object.entries(SOURCES).map(([type, source]) => ({ name: type, source: source(payload) })),
  }));
  const fences = Object.entries(FEATURES).map(([name, source]) => ({ name, source }));
  return [...documents, { file: "features.md", title: "Hostile features", fences }];
}

function writeContentRepo(dir: string, documents: HostileDocument[]): void {
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "designiq.yml"), "models: docs\n");
  for (const { file, title, fences } of documents) {
    const body = fences.map(({ name, source }) => `## ${name}\n\n\`\`\`mermaid\n${source}\`\`\`\n`).join("\n");
    writeFileSync(join(dir, "docs", file), `# ${title}\n\n${body}`);
  }
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
    const up = await fetch(`${BASE}/mermaid-frame.html`).then(
      (res) => res.ok,
      () => false,
    );
    if (up) return host;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  host.kill();
  throw new Error(`The Live Host did not start on ${BASE}:\n${log}`);
}

/** runs in every frame before its own scripts: what a hostile source could make it do */
function trap({ tracker }: { tracker: string }): void {
  const win = window as unknown as Record<string, unknown> & { __hostileReport(json: string): void };
  const report = (kind: string, detail: string): void => {
    try {
      win.__hostileReport(JSON.stringify({ kind, detail: detail.slice(0, 240), frame: location.href }));
    } catch {
      /* the binding is gone with its page */
    }
  };
  win.__pwn = (marker: unknown) => report("script", `__pwn(${String(marker)})`);
  for (const name of ["alert", "confirm", "prompt", "print"]) {
    win[name] = (text: unknown) => report("script", `${name}(${String(text)})`);
  }
  document.addEventListener(
    "securitypolicyviolation",
    (e) => report("policy", `${e.effectiveDirective} ${e.blockedURI}`),
    true,
  );
  const SCRIPT_URL = /^\s*(?:javascript|vbscript|data:text\/html)/i;
  const ADDRESSES = [
    "src",
    "href",
    "xlink:href",
    "srcset",
    "poster",
    "background",
    "data",
    "action",
    "formaction",
    "ping",
  ];
  const CSS = [
    "style",
    "fill",
    "stroke",
    "filter",
    "clip-path",
    "mask",
    "marker",
    "marker-start",
    "marker-mid",
    "marker-end",
    "cursor",
  ];
  const hostile = (value: string): boolean =>
    value.includes("__pwn") || value.includes(tracker) || SCRIPT_URL.test(value);
  const inspect = (el: Element): void => {
    const tag = el.localName;
    for (const { name, value } of el.attributes) {
      if (!hostile(value)) continue;
      const link = tag === "a" && (name === "href" || name === "xlink:href") && !SCRIPT_URL.test(value);
      const css = CSS.includes(name) && /url\(/i.test(value);
      if (name.startsWith("on") || (ADDRESSES.includes(name) && !link) || css) {
        report("node", `${name}=${value} on <${tag}>`);
      }
    }
    if ((tag === "style" || tag === "script") && hostile(el.textContent ?? "")) {
      report("node", `<${tag}> ${el.textContent ?? ""}`);
    }
  };
  const start = (): void =>
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") inspect(r.target as Element);
        for (const node of r.addedNodes) {
          if (node instanceof Element) [node, ...node.querySelectorAll("*")].forEach(inspect);
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true });
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });
}

/** the MCP-Apps host the widgets talk to: initialize, the tool input, get_model_content */
const MCP_HOST_PAGE = `<!doctype html><html><body style="margin:0"><iframe id="w" style="width:900px;height:640px;border:0"></iframe><script>
const frame = document.getElementById("w");
const post = (msg) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...msg }, "*");
window.addEventListener("message", async (e) => {
  if (e.source !== frame.contentWindow || e.data?.jsonrpc !== "2.0") return;
  const m = e.data;
  if (m.method === "ui/initialize") {
    post({ id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: "hostile-check", version: "1.0.0" },
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

interface Seen {
  kind: "script" | "policy" | "node";
  detail: string;
  frame: string;
  /** in the page's own document, not one of its frames */
  inPage: boolean;
}
interface Loaded {
  phase: Phase;
  url: string;
  /** a new tab a reader's click on a link opened */
  popup: boolean;
  referer?: string;
}
type Phase = "open" | "click" | "control";

const failures: string[] = [];
const fail = (what: string): void => void failures.push(what);
const expect = (ok: boolean, what: string): void => (ok ? console.log(`control: ${what}`) : fail(`control: ${what}`));
/** in the page, the Mermaid frame or a widget: a handler, an image and a clicked javascript: link of `marker` */
function injectControl({ marker, tracker }: { marker: string; tracker: string }): void {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<img src="https://${tracker}/${marker}" onerror="__pwn('${marker}')"><a id="${marker}" href="javascript:__pwn('${marker}-link')">x</a>`,
  );
  document.getElementById(marker)!.click();
}

const playwright = loadPlaywright();
for (const file of ["index.html", "mermaid-frame.html", ...WIDGETS]) {
  if (!existsSync(join(DIST, file))) throw new Error(`apps/web/dist/${file} is missing: run pnpm build first.`);
}
const work = mkdtempSync(join(tmpdir(), "designiq-hostile-mermaid-"));
const documents = hostileDocuments();
writeContentRepo(join(work, "content"), documents);
const host = await startLiveHost(join(work, "content"), join(work, "data"));
const browser = await playwright.chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const seen: Seen[] = [];
  const loaded: Loaded[] = [];
  const popups: Page[] = [];
  let phase: Phase = "open";
  let current: Page | undefined;
  const reset = (next: Phase): void => {
    seen.length = 0;
    loaded.length = 0;
    phase = next;
  };

  await context.exposeBinding("__hostileReport", ({ frame }, json) => {
    const event = JSON.parse(json) as Omit<Seen, "inPage">;
    seen.push({ ...event, inPage: frame === frame.page().mainFrame() });
  });
  await context.exposeBinding("__tool", (_source, params) => {
    const { name, arguments: args } = JSON.parse(params) as {
      name: string;
      arguments?: { repo: string; path: string };
    };
    if (name !== "get_model_content" || !documents.some((d) => `docs/${d.file}` === args?.path)) {
      return JSON.stringify({ isError: true, content: [{ type: "text", text: `${name} is not offered here` }] });
    }
    const content = readFileSync(join(work, "content", args!.path), "utf8");
    const wire = { repo: args!.repo, path: args!.path, content, xml: content, baseVersion: "hostile" };
    return JSON.stringify({ content: [{ type: "text", text: JSON.stringify(wire) }] });
  });
  await context.addInitScript(trap, { tracker: TRACKER });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === MCP_HOST) return route.fulfill({ contentType: "text/html", body: MCP_HOST_PAGE });
    if (url.origin === WIDGET_ORIGIN) {
      const file = url.pathname.slice(1);
      if (!WIDGETS.includes(file)) return route.fulfill({ status: 404, body: "" });
      const boot = JSON.stringify(JSON.stringify({ readonly: true, publicUrl: BASE }));
      const html = readFileSync(join(DIST, file), "utf8").replace('"__DESIGNIQ_BOOT__"', () => boot);
      return route.fulfill({ contentType: "text/html", body: html });
    }
    if (url.origin === BASE) return route.continue();
    // a link's new tab asks for its address before its frame exists
    let popup = request.isNavigationRequest();
    try {
      popup = request.frame().page() !== current;
    } catch {
      /* no frame yet (that new tab) or none at all (a worker) */
    }
    loaded.push({ phase, url: request.url(), popup, referer: (await request.allHeaders()).referer });
    // nothing leaves this machine; a hostile image still gets its error
    return route.fulfill({ status: 404, body: "" });
  });
  context.on("page", (page) => {
    page.on("dialog", (dialog) => {
      seen.push({ kind: "script", detail: `dialog ${dialog.message()}`, frame: "", inPage: true });
      void dialog.dismiss();
    });
    if (phase === "click") popups.push(page);
  });

  const spa = [];
  for (const doc of documents) {
    reset("open");
    current = await context.newPage();
    await current.goto(`${BASE}/r/${REPO}/f/docs/${doc.file}`);
    await current.waitForFunction(
      (count) =>
        document.querySelectorAll(".md-mermaid-block").length >= count &&
        !document.querySelector(".md-mermaid-block[aria-busy]"),
      doc.fences.length,
      { timeout: 300_000, polling: 250 },
    );
    await current.waitForTimeout(1000);
    const state = await current.evaluate(
      () => ({
        drawn: document.querySelectorAll(".md-mermaid-diagram > svg").length,
        notices: [...document.querySelectorAll(".md-mermaid-block")].map((block) =>
          [...block.querySelectorAll(".md-mermaid-notice-title, .md-mermaid-notice-message")]
            .map((line) => line.textContent)
            .join(": "),
        ),
        scriptLinks: document.querySelectorAll('[href^="javascript:" i], [*|href^="javascript:" i]').length,
        frame: (() => {
          const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Mermaid layout"]');
          if (!frame) return "missing";
          const policy = frame.contentDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]');
          return policy ? "with its policy" : "without its policy";
        })(),
      }),
      undefined,
    );
    const openedWith = loaded.length;

    phase = "click";
    await current.evaluate(() => {
      for (const el of document.querySelectorAll(".md-mermaid-diagram *")) {
        for (const type of ["mouseover", "mouseenter", "focus", "click"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }
    }, undefined);
    await current.waitForTimeout(1000);
    const clicked = loaded.filter((r) => r.phase === "click");
    const scripts = seen.filter((e) => e.kind === "script");
    const pageNodes = seen.filter((e) => e.kind === "node" && e.inPage);

    if (state.frame !== "with its policy") fail(`${doc.file}: the Mermaid frame is ${state.frame}`);
    for (const e of scripts) fail(`${doc.file}: ran ${e.detail} in ${e.frame}`);
    for (const r of loaded.filter((r) => r.phase === "open")) fail(`${doc.file}: loaded ${r.url} as it opened`);
    for (const r of clicked.filter((r) => !r.popup)) fail(`${doc.file}: a click loaded ${r.url} in the page`);
    for (const r of clicked.filter((r) => r.referer)) fail(`${doc.file}: a link sent its referer ${r.referer}`);
    for (const e of pageNodes) fail(`${doc.file}: the page's document held ${e.detail}`);
    if (state.scriptLinks > 0) fail(`${doc.file}: ${state.scriptLinks} javascript: links in the page's document`);
    if (doc.file === "features.md") {
      const shapes = Object.keys(FEATURES).indexOf("flowchart shapes");
      if (!state.notices[shapes]?.endsWith(SHAPE_IMAGE_FROM_ADDRESS)) {
        fail(`features.md: the shape image reads "${state.notices[shapes]}", not "${SHAPE_IMAGE_FROM_ADDRESS}"`);
      }
      for (const [i, notice] of state.notices.entries()) if (notice) console.log(`${doc.fences[i]!.name}: ${notice}`);
    }
    spa.push({
      document: doc.file,
      fences: doc.fences.length,
      drawn: state.drawn,
      notices: state.notices.filter(Boolean).length,
      "requests (open)": openedWith,
      "requests (reader clicks)": clicked.length,
      scripts: scripts.length,
      "hostile nodes in page": pageNodes.length,
      "hostile nodes in frame": seen.filter((e) => e.kind === "node" && !e.inPage).length,
    });
    for (const popup of popups.splice(0)) await popup.close();
    await current.close();
  }
  console.log("SPA, every diagram element clicked:");
  console.table(spa);

  // the page's own document runs and loads what the frame's policy refuses
  reset("control");
  current = await context.newPage();
  await current.goto(`${BASE}/r/${REPO}/f/docs/features.md`);
  await current.waitForFunction(() => document.querySelector(".md-mermaid-diagram > svg"), undefined, {
    timeout: 300_000,
  });
  await current.evaluate(injectControl, { marker: "control-page", tracker: TRACKER });
  const mermaidFrame = current.frames().find((f) => f.url() === "about:srcdoc");
  if (!mermaidFrame) fail("control: no Mermaid frame on the page");
  await mermaidFrame?.evaluate(injectControl, { marker: "control-frame", tracker: TRACKER });
  await current.waitForTimeout(1500);
  const ran = seen.filter((e) => e.kind === "script").map((e) => e.detail);
  const refused = new Set(seen.filter((e) => e.kind === "policy" && !e.inPage).map((e) => e.detail.split(" ")[0]));
  expect(ran.includes("__pwn(control-page)"), "a handler in the page runs and is seen");
  expect(ran.includes("__pwn(control-page-link)"), "a javascript: link in the page runs and is seen");
  expect(
    loaded.some((r) => r.url.endsWith("/control-page")),
    "an image in the page loads and is seen",
  );
  expect(!ran.some((r) => r.includes("control-frame")), "neither a handler nor a javascript: link runs in the frame");
  expect(!loaded.some((r) => r.url.endsWith("/control-frame")), "an image in the frame does not load");
  expect(
    ["img-src", "script-src-attr", "script-src-elem"].every((d) => refused.has(d)),
    `the frame's policy refused them (${[...refused].join(", ")})`,
  );
  await current.close();

  const widgets = [];
  for (const widget of WIDGETS) {
    for (const doc of documents) {
      reset("open");
      current = await context.newPage();
      await current.goto(`${MCP_HOST}/host.html`);
      await current.evaluate(
        ({ args, src }) => {
          Object.assign(window, { __args: args });
          document.querySelector("iframe")!.src = src;
        },
        { args: { repo: REPO, path: `docs/${doc.file}` }, src: `${WIDGET_ORIGIN}/${widget}` },
      );
      await current.waitForTimeout(4000);
      const frame = current.frames().find((f) => f.url().startsWith(WIDGET_ORIGIN));
      const shows = (await frame?.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim(), undefined)) ?? "";
      phase = "click";
      await frame?.evaluate(() => {
        for (const el of document.querySelectorAll("body *")) {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
      }, undefined);
      await current.waitForTimeout(500);
      const requests = loaded.filter((r) => !r.popup);
      const events = seen.filter((e) => e.kind !== "policy");
      if (!frame) fail(`${widget} ${doc.file}: the widget did not open`);
      for (const r of requests) fail(`${widget} ${doc.file}: loaded ${r.url}`);
      for (const e of events) fail(`${widget} ${doc.file}: ${e.kind} ${e.detail}`);
      widgets.push({
        widget,
        document: doc.file,
        requests: requests.length,
        "scripts and hostile nodes": events.length,
        shows: shows.slice(0, 60),
      });
      for (const popup of popups.splice(0)) await popup.close();
      if (frame && widgets.length === 1) {
        reset("control");
        await frame.evaluate(injectControl, { marker: "control-widget", tracker: TRACKER });
        await current.waitForTimeout(1000);
        expect(
          seen.some((e) => e.detail === "__pwn(control-widget)") &&
            loaded.some((r) => r.url.endsWith("/control-widget")),
          "a handler and an image in a widget run, load and are seen",
        );
      }
      await current.close();
    }
  }
  console.log("Widgets:");
  console.table(widgets);
} finally {
  await browser.close();
  host.kill();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nNothing of a hostile diagram ran or loaded.");
