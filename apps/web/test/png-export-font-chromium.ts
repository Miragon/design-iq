/**
 * The PNG exports' labels in Geist (issue 285), in the built app, in headless
 * Chromium: a check run by hand, not by `pnpm test`, because CI has no
 * browser and jsdom draws no image (test/miragon-menus.test.ts checks what
 * goes into the image). Run it after a renderer, fontsource or browser
 * update, from the repository root:
 *
 *   pnpm build
 *   npx -y playwright@1.56.1 install --only-shell chromium     # once
 *   npx -y -p playwright@1.56.1 -c "node apps/web/test/png-export-font-chromium.ts"
 *
 * BROWSER=webkit runs it in WebKit (`install webkit` instead, once).
 *
 * It starts a Live Host of its own (LIVE_AUTH=none, on PORT, 8393 unless
 * set) on a generated content repo with a Wardley map, an Event Storming
 * board, a Context Map, a Team Topology and a Value Chain, each with one label
 * to measure (it holds figures, where Geist and the system sans differ most)
 * and a latin-ext text beside it, so two subsets go in. It exports each as PNG
 * and as SVG from the SPA's ⋯ menu, and from the notation's widget behind a
 * minimal MCP-Apps host that
 * serves it under the MCP Apps default CSP, whose font-src (default-src
 * 'none') blocks every data: font of the widget's own document. Then it draws
 * the exported SVG itself, with Geist from @fontsource-variable/geist and in
 * the system sans, each once more without the label, and takes the label's
 * ink width from each pair. The PNG's label must be as wide as Geist's and
 * not as the system sans', the whole PNG must be the drawing in Geist, and
 * the SVG download must stay without an embedded font. Exits 1 on a failure.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** the part of Playwright's API this check uses: Playwright is no dependency of the repo */
interface Download {
  path(): Promise<string>;
  suggestedFilename(): string;
}
interface Frame {
  url(): string;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>;
}
interface Page extends Frame {
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
  frames(): Frame[];
  waitForEvent(event: "download", options: { timeout: number }): Promise<Download>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): void;
}
interface Route {
  request(): { url(): string };
  continue(): Promise<void>;
  fulfill(response: {
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<void>;
}
interface BrowserContext {
  newPage(): Promise<Page>;
  exposeBinding(name: string, binding: (source: unknown, arg: string) => unknown): Promise<void>;
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
interface BrowserType {
  launch(options: { headless: boolean }): Promise<{
    newContext(options: { viewport: { width: number; height: number } }): Promise<BrowserContext>;
    close(): Promise<void>;
  }>;
}
type Playwright = Record<"chromium" | "webkit", BrowserType>;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const PORT = Number(process.env.PORT ?? 8393);
const BASE = `http://localhost:${PORT}`;
const REPO = "acme/exports";
/** the fake MCP-Apps host, the widgets' origin and the measuring page: answered by this check */
const MCP_HOST = "http://mcp-host.test";
const WIDGET_ORIGIN = "http://widget.test";
const MEASURE = "http://measure.test";
/** what an MCP Apps host sets for a resource that declares no resourceDomains */
const MCP_DEFAULT_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; media-src 'self' data:; connect-src 'none'";
/** the PNG's label may be this many pixels (at 2×) off Geist's: anti-aliasing at the ends */
const TOLERANCE = 1;

/** the one npx puts on PATH */
function loadPlaywright(): Playwright {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = join(dir, "playwright");
    if (existsSync(bin)) return createRequire(realpathSync(bin))("playwright") as Playwright;
  }
  throw new Error('No playwright on PATH: run this through npx -p playwright@1.56.1 -c "node …" (see its header).');
}

interface Model {
  notation: string;
  file: string;
  text: string;
  widget: string;
  /** the one label measured: alone on its line, clear of every other text */
  label: string;
  /** what lies under the SVG in the PNG (lib/export-image.ts) */
  paper: string;
  /** the drawing leaves its corner bare, so the PNG's corner is the paper: nothing of the renderer's covers it */
  paperAtCorner?: boolean;
}

const MODELS: Model[] = [
  {
    notation: "wardley",
    file: "tea.wmap",
    text: "title Tea Shop\ncomponent Tier 1 Support [0.70, 0.30]\ncomponent Kettle from Łódź [0.30, 0.75]\n",
    widget: "mcp-app-wardley.html",
    label: "Tier 1 Support",
    paper: "#FFFFFF",
  },
  {
    notation: "event-storming",
    file: "box-office.storm",
    text: "title Box Office\ncommand Sell in Łódź [240, 300]\nevent Ticket 11 Sold [620, 300]\n",
    widget: "mcp-app-event-storming.html",
    label: "Ticket 11 Sold",
    paper: "#F9F7F7",
  },
  {
    notation: "context-map",
    file: "airport.cm.json",
    text: `${JSON.stringify(
      {
        version: 1,
        title: "Airport",
        contexts: [
          { label: "Gate 11 Check-in", id: "ctx_gate", position: { x: 40, y: 40 }, size: { width: 320, height: 110 } },
          { label: "Łódź Desk", id: "ctx_desk", position: { x: 40, y: 220 }, size: { width: 320, height: 110 } },
        ],
        relationships: [],
      },
      null,
      2,
    )}\n`,
    widget: "mcp-app-context-map.html",
    label: "Gate 11 Check-in",
    paper: "#F9F7F7",
  },
  {
    notation: "team-topology",
    file: "squads.tt",
    text: `${JSON.stringify(
      {
        version: 3,
        title: "Squads",
        nodes: [
          {
            id: "team_payments",
            type: "stream-aligned",
            label: "Squad 11 Payments",
            position: { x: 40, y: 40 },
            size: { width: 280, height: 96 },
          },
          {
            id: "team_platform",
            type: "platform",
            label: "Łódź Platform",
            position: { x: 40, y: 220 },
            size: { width: 280, height: 96 },
          },
        ],
        interactions: [],
        flows: [],
      },
      null,
      2,
    )}\n`,
    widget: "mcp-app-team-topology.html",
    label: "Squad 11 Payments",
    paper: "#F9F7F7",
    paperAtCorner: true,
  },
  {
    notation: "value-chain",
    file: "harbour.vc.json",
    text: `${JSON.stringify(
      {
        connections: [],
        elements: [
          {
            bounds: { height: 80, width: 320, x: 40, y: 40 },
            elementType: "step",
            id: "step_berth",
            name: "Berth 11 Unloading",
          },
          {
            bounds: { height: 80, width: 320, x: 40, y: 220 },
            elementType: "step",
            id: "step_desk",
            name: "Łódź Customs",
          },
        ],
        meta: { name: "Harbour" },
        schemaVersion: 1,
      },
      null,
      2,
    )}\n`,
    widget: "mcp-app-value-chain.html",
    label: "Berth 11 Unloading",
    paper: "#F9F7F7",
  },
];

/** Geist as the check's own reference, not lib/export-font.ts' output:
 *  fontsource's wght.css, every subset, its files inline */
function referenceGeist(): string {
  const geist = join(ROOT, "apps/web/node_modules/@fontsource-variable/geist");
  return readFileSync(join(geist, "wght.css"), "utf8").replace(
    /url\(\.\/(files\/[^)]+\.woff2)\)/g,
    (_, file: string) => `url(data:font/woff2;base64,${readFileSync(join(geist, file)).toString("base64")})`,
  );
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

/** the MCP-Apps host the widgets talk to: initialize with downloadFile, the tool input, get_model_content, downloads */
const MCP_HOST_PAGE = `<!doctype html><html><body style="margin:0"><iframe id="w" style="width:1100px;height:760px;border:0"></iframe><script>
const frame = document.getElementById("w");
const post = (msg) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...msg }, "*");
window.addEventListener("message", async (e) => {
  if (e.source !== frame.contentWindow || e.data?.jsonrpc !== "2.0") return;
  const m = e.data;
  if (m.method === "ui/initialize") {
    post({ id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: "png-font-check", version: "1.0.0" },
      hostCapabilities: { serverTools: {}, openLinks: {}, logging: {}, downloadFile: {} },
      hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: 1100, maxHeight: 760 } } } });
  } else if (m.method === "ui/notifications/initialized") {
    post({ method: "ui/notifications/tool-input", params: { arguments: window.__args } });
    post({ method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: JSON.stringify({ opened: window.__args }) }] } });
  } else if (m.method === "tools/call") {
    post({ id: m.id, result: JSON.parse(await window.__tool(JSON.stringify(m.params))) });
  } else if (m.method === "ui/download-file") {
    await window.__download(JSON.stringify(m.params));
    post({ id: m.id, result: {} });
  } else if (m.id !== undefined) {
    post({ id: m.id, result: {} });
  }
});
</script></body></html>`;

interface Exported {
  /** the PNG, base64 */
  png: string;
  svg: string;
}

interface Widths {
  /** the label's ink width in the exported PNG, in pixels at 2× */
  png: number;
  geist: number;
  system: number;
  /** pixels of the whole PNG that differ from the check's own drawing in Geist, and in the system sans */
  offGeist: number;
  offSystem: number;
  /** the PNG's top-left pixel, as #RRGGBB */
  corner: string;
}

/** in the measuring page: the label's ink width in the exported PNG, and in the check's own drawings */
async function measureLabel(input: {
  svg: string;
  png: string;
  label: string;
  paper: string;
  geist: string;
}): Promise<Widths> {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const source = new DOMParser().parseFromString(input.svg, "image/svg+xml").documentElement;
  const width = Number.parseFloat(source.getAttribute("width") ?? "") * 2;
  const height = Number.parseFloat(source.getAttribute("height") ?? "") * 2;
  const variant = (geist: boolean, withLabel: boolean): string => {
    const svg = new DOMParser().parseFromString(input.svg, "image/svg+xml");
    // the Team Topologies PNG is drawn without the renderer's white sheet (notations/miragon/team-topology.ts)
    for (const sheet of [...svg.querySelectorAll("rect.tt-export-paper")]) sheet.remove();
    if (!withLabel) {
      const flat = (text: string | null) => (text ?? "").replace(/\s+/g, "");
      for (const text of [...svg.querySelectorAll("text")])
        if (flat(text.textContent) === flat(input.label)) text.remove();
    }
    if (geist) {
      const style = svg.createElementNS(SVG_NS, "style");
      style.textContent = input.geist;
      svg.documentElement.prepend(style);
    } else {
      // the system sans even where Geist is installed
      for (const element of [...svg.querySelectorAll("[style], [font-family]")]) {
        for (const name of ["style", "font-family"]) {
          const value = element.getAttribute(name);
          if (value) element.setAttribute(name, value.replace(/["']?Geist( Variable)?["']?,\s*/g, ""));
        }
      }
    }
    return new XMLSerializer().serializeToString(svg);
  };
  const pixels = async (src: string): Promise<Uint8ClampedArray> => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    const paint = () => {
      context.fillStyle = input.paper;
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    };
    // the reference's own subsets may still be loading at the first paint
    // (lib/export-font.ts): it is painted again until it holds still
    let last = paint();
    for (let tries = 0; tries < 20; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = paint();
      if (next.every((value, at) => value === last[at])) return next;
      last = next;
    }
    throw new Error("a reference drawing never held still");
  };
  const drawn = (svg: string) => pixels(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const differs = (a: Uint8ClampedArray, b: Uint8ClampedArray, at: number) =>
    Math.abs(a[at]! - b[at]!) + Math.abs(a[at + 1]! - b[at + 1]!) + Math.abs(a[at + 2]! - b[at + 2]!) > 48;
  type Box = { left: number; right: number; top: number; bottom: number };
  const ink = (a: Uint8ClampedArray, b: Uint8ClampedArray, within?: Box): Box | undefined => {
    let box: Box | undefined;
    for (let y = within?.top ?? 0; y <= (within?.bottom ?? height - 1); y++) {
      for (let x = within?.left ?? 0; x <= (within?.right ?? width - 1); x++) {
        if (!differs(a, b, (y * width + x) * 4)) continue;
        box ??= { left: x, right: x, top: y, bottom: y };
        box.left = Math.min(box.left, x);
        box.right = Math.max(box.right, x);
        box.top = Math.min(box.top, y);
        box.bottom = Math.max(box.bottom, y);
      }
    }
    return box;
  };
  const span = (box: Box | undefined) => (box ? box.right - box.left + 1 : 0);
  const [png, geist, geistBare, system, systemBare] = await Promise.all([
    pixels(`data:image/png;base64,${input.png}`),
    drawn(variant(true, true)),
    drawn(variant(true, false)),
    drawn(variant(false, true)),
    drawn(variant(false, false)),
  ]);
  const inGeist = ink(geist, geistBare);
  const inSystem = ink(system, systemBare);
  if (!inGeist || !inSystem) throw new Error(`no <text> "${input.label}" in the SVG`);
  // the label's place in either font, with room: only the label differs there
  const around: Box = {
    left: Math.max(0, Math.min(inGeist.left, inSystem.left) - 4),
    right: Math.min(width - 1, Math.max(inGeist.right, inSystem.right) + 4),
    top: Math.max(0, Math.min(inGeist.top, inSystem.top) - 4),
    bottom: Math.min(height - 1, Math.max(inGeist.bottom, inSystem.bottom) + 4),
  };
  let offGeist = 0;
  let offSystem = 0;
  for (let at = 0; at < png.length; at += 4) {
    if (differs(png, geist, at)) offGeist++;
    if (differs(png, system, at)) offSystem++;
  }
  const corner =
    `#${[png[0], png[1], png[2]].map((value) => value!.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return {
    png: span(ink(png, geistBare, around)),
    geist: span(inGeist),
    system: span(inSystem),
    offGeist,
    offSystem,
    corner,
  };
}

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const playwright = loadPlaywright();
for (const file of ["index.html", ...MODELS.map((m) => m.widget)]) {
  if (!existsSync(join(DIST, file))) throw new Error(`apps/web/dist/${file} is missing: run pnpm build first.`);
}
const work = mkdtempSync(join(tmpdir(), "designiq-png-font-"));
mkdirSync(join(work, "content", "models"), { recursive: true });
writeFileSync(join(work, "content", "designiq.yml"), "models: models\n");
for (const model of MODELS) writeFileSync(join(work, "content", "models", model.file), model.text);
const host = await startLiveHost(join(work, "content"), join(work, "data"));
const engine = process.env.BROWSER === "webkit" ? "webkit" : "chromium";
const browser = await playwright[engine].launch({ headless: true });
console.log(`in headless ${engine}`);
const geist = referenceGeist();

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const downloads: string[] = [];
  await context.exposeBinding("__download", (_source, params) => void downloads.push(params));
  await context.exposeBinding("__tool", (_source, params) => {
    const { name, arguments: args } = JSON.parse(params) as { name: string; arguments?: { path?: string } };
    const model = MODELS.find((m) => `models/${m.file}` === args?.path);
    if (name !== "get_model_content" || !model) {
      return JSON.stringify({ isError: true, content: [{ type: "text", text: `${name} is not offered here` }] });
    }
    const wire = { repo: REPO, path: args!.path, content: model.text, baseVersion: "check" };
    return JSON.stringify({ content: [{ type: "text", text: JSON.stringify(wire) }] });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === MCP_HOST) return route.fulfill({ contentType: "text/html", body: MCP_HOST_PAGE });
    if (url.origin === MEASURE)
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>measure</title>" });
    if (url.origin === WIDGET_ORIGIN) {
      const file = url.pathname.slice(1);
      if (!MODELS.some((m) => m.widget === file)) return route.fulfill({ status: 404, body: "" });
      const boot = JSON.stringify(JSON.stringify({ readonly: true, publicUrl: BASE }));
      const html = readFileSync(join(DIST, file), "utf8").replace('"__DESIGNIQ_BOOT__"', () => boot);
      return route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": MCP_DEFAULT_CSP },
        body: html,
      });
    }
    if (url.origin === BASE) return route.continue();
    return route.fulfill({ status: 404, body: "" });
  });
  const measuring = await context.newPage();
  await measuring.goto(`${MEASURE}/`);

  /** the SPA: the model's page, its ⋯ menu, the browser's download — a page
   *  per export: Chromium lets a page start one download without a click */
  async function fromSpa(model: Model): Promise<Exported> {
    const save = async (entry: string): Promise<Buffer> => {
      const page = await context.newPage();
      await page.goto(`${BASE}/r/${REPO}/f/models/${model.file}`);
      await page.waitForSelector(".djs-element[data-element-id]", { timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready.then(() => undefined), undefined);
      await page.click('button[aria-label="More"]');
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30_000 }),
        page.click(`role=menuitem[name="${entry}"]`),
      ]);
      const file = readFileSync(await download.path());
      await page.close();
      return file;
    };
    return {
      png: (await save("Export as PNG")).toString("base64"),
      svg: (await save("Export as SVG")).toString("utf8"),
    };
  }

  /** the widget under the MCP default CSP: its menu, the host's ui/download-file */
  async function fromWidget(model: Model): Promise<Exported & { blocked: string[] }> {
    const page = await context.newPage();
    const blocked: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/.test(message.text())) blocked.push(message.text());
    });
    await page.goto(`${MCP_HOST}/host.html`);
    await page.evaluate(
      ({ args, src }) => {
        (window as unknown as { __args: unknown }).__args = args;
        (document.getElementById("w") as HTMLIFrameElement).src = src;
      },
      { args: { repo: REPO, path: `models/${model.file}` }, src: `${WIDGET_ORIGIN}/${model.widget}` },
    );
    let frame: Frame | undefined;
    for (const deadline = Date.now() + 30_000; !frame && Date.now() < deadline; await page.waitForTimeout(100)) {
      frame = page.frames().find((f) => f.url().startsWith(WIDGET_ORIGIN));
    }
    if (!frame) throw new Error(`${model.widget} did not load`);
    await frame.waitForSelector(".djs-element[data-element-id]", { timeout: 60_000 });
    await frame.evaluate(() => document.fonts.ready.then(() => undefined), undefined);
    const save = async (key: string): Promise<{ text?: string; blob?: string }> => {
      const before = downloads.length;
      await frame.click("#menu-trigger");
      await frame.click(`[data-key="${key}"]`);
      for (const deadline = Date.now() + 30_000; downloads.length === before && Date.now() < deadline;) {
        await page.waitForTimeout(100);
      }
      const params = JSON.parse(downloads[before] ?? "null") as {
        contents: { resource: { text?: string; blob?: string } }[];
      } | null;
      if (!params) throw new Error(`${model.widget}: ${key} reached no download`);
      return params.contents[0]!.resource;
    };
    const png = (await save("modeler:export-png")).blob ?? "";
    const svg = (await save("modeler:export-svg")).text ?? "";
    await page.close();
    return { png, svg, blocked };
  }

  for (const model of MODELS) {
    for (const where of ["SPA", "widget"] as const) {
      const name = `${model.notation} in the ${where}`;
      let exported: Exported & { blocked?: string[] };
      try {
        exported = where === "SPA" ? await fromSpa(model) : await fromWidget(model);
      } catch (error) {
        check(false, `${name}: ${(error as Error).message}`);
        continue;
      }
      if (process.env.DEBUG_DIR) {
        writeFileSync(
          join(process.env.DEBUG_DIR, `${model.notation}-${where}.png`),
          Buffer.from(exported.png, "base64"),
        );
        writeFileSync(join(process.env.DEBUG_DIR, `${model.notation}-${where}.svg`), exported.svg);
      }
      if (exported.blocked) {
        check(
          exported.blocked.some((line) => /font/i.test(line)),
          `${name}: the CSP blocks the widget's own data: fonts (${exported.blocked.length} reports)`,
        );
      }
      check(!/@font-face/.test(exported.svg), `${name}: the SVG download carries no font`);
      const widths = await measuring.evaluate(measureLabel, {
        svg: exported.svg,
        png: exported.png,
        label: model.label,
        paper: model.paper,
        geist,
      });
      console.log(
        `     "${model.label}": PNG ${widths.png} px, Geist ${widths.geist} px, system sans ${widths.system} px (2×); ` +
          `pixels of the PNG off the check's own drawing in Geist ${widths.offGeist}, in the system sans ${widths.offSystem}`,
      );
      check(Math.abs(widths.geist - widths.system) > 2 * TOLERANCE, `${name}: the label tells the fonts apart`);
      check(Math.abs(widths.png - widths.geist) <= TOLERANCE, `${name}: the PNG's label is as wide as in Geist`);
      check(
        widths.offGeist === 0 && widths.offSystem > 0,
        `${name}: the PNG is the drawing in Geist, every label and subset`,
      );
      if (model.paperAtCorner) {
        check(widths.corner === model.paper.toUpperCase(), `${name}: the PNG's corner is the paper (${widths.corner})`);
      }
    }
  }
  await context.close();
} finally {
  await browser.close();
  host.kill();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nEvery PNG export draws its labels in Geist.");
