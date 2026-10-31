/**
 * Where the header's logo leads (src/components/app-header.tsx, #184) and the
 * repository overview's own way to the list of every repository
 * (src/routes/repo.tsx), rendered with React under jsdom (test/component-dom.ts)
 * in a router on the app's paths (src/router.tsx). Inside a repository, on its
 * overview, in one of its folders or in an editor, the logo leads to that
 * repository's root overview and its name says so; anywhere else it leads to
 * the list of repositories, as before. It is the page shown only there, on the
 * root overview or the start page, never in a folder or an editor. The
 * repository is the one in the address, so the logo follows a move to another
 * repository. On every page the logo has the CI focus ring with its gap, as the
 * app's buttons do. The overview, at its root and in a folder, keeps its
 * Repositories link to the list.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, afterEach, test } from "node:test";

import { closeDom } from "./component-dom.ts";

after(closeDom);

// under node the router renders as on a server, which fails in a document; the jsdom page is the browser here
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "@tanstack/router-core/isServer") return nextResolve(specifier, context);
    return nextResolve(specifier, { ...context, conditions: ["browser", ...context.conditions] });
  },
});

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
  await import("@tanstack/react-router");
const { focusRing } = await import("@designiq/ui-kit/components/button");
const { AppHeader } = await import("../src/components/app-header.tsx");
const { ProcessList } = await import("../src/routes/repo.tsx");

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
// the router restores the scroll after each navigation, which jsdom does not implement
globalThis.scrollTo = () => {};

/** the routes of src/router.tsx, in its order: the start page, a repository's overview and its two editors */
const PATHS = ["/", "/r/$owner/$repo", "/r/$owner/$repo/p/$processId", "/r/$owner/$repo/f/$"];

test("the routes here are the app's routes", () => {
  const source = readFileSync(new URL("../src/router.tsx", import.meta.url), "utf8");
  assert.deepEqual(
    [...source.matchAll(/\bpath: "([^"]+)"/g)].map((match) => match[1]),
    PATHS,
  );
});

/** what the Live Host answers the header and the overview: an empty content repo with two nested folders */
function answer(path: string): unknown {
  if (path === "/api/config") return { providers: [], auth: "none", installUrl: null, mcpUrl: "" };
  if (path === "/api/me")
    return { user: { login: "ada", name: "Ada", avatarUrl: null, provider: "local" }, wsToken: "" };
  if (path === "/api/repos") return [];
  if (path.startsWith("/api/me/recent/")) return { fullName: path.slice(15), lastOpenedAt: new Date(0).toISOString() };
  if (path.endsWith("/folders")) return { isContentRepo: true, folders: ["sub", "sub/deeper"] };
  if (/\/(processes|decisions|models)$/.test(path)) return [];
  return undefined;
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input instanceof Request ? input.url : input), "http://localhost/").pathname;
  const body = answer(path);
  return body === undefined
    ? new Response(JSON.stringify({ error: `no ${path}` }), { status: 404 })
    : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await settle();
});

/** the header over the routes, as RootLayout lays them out, opened at `location` */
async function mount(location: string) {
  const rootRoute = createRootRoute({
    component: () =>
      createElement("div", null, createElement(AppHeader), createElement("main", null, createElement(Outlet))),
  });
  const editor = () => createElement("p", null, "editor");
  const [start, overview, processEditor, fileEditor] = PATHS as [string, string, string, string];
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: start, component: () => createElement("p", null, "start") }),
    createRoute({ getParentRoute: () => rootRoute, path: overview, component: ProcessList }),
    createRoute({ getParentRoute: () => rootRoute, path: processEditor, component: editor }),
    createRoute({ getParentRoute: () => rootRoute, path: fileEditor, component: editor }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [location] }) });
  // no garbage collection timers: the default five minutes keep node running long after the last case
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router: router as never })),
  );
  await router.load();
  await settle();
  cleanups.push(() => {
    root.unmount();
    client.clear();
    host.remove();
  });
  const logo = (): HTMLAnchorElement => {
    const link = host.querySelector<HTMLAnchorElement>("header > a");
    assert.ok(link, "the logo");
    return link;
  };
  return { host, router, logo };
}

/** the logo's target, whether it is the page shown, its name, which starts with the word it shows (WCAG 2.5.3), and its focus ring */
function assertLogo(logo: HTMLAnchorElement, href: string, current: boolean, name: string): void {
  assert.equal(logo.getAttribute("href"), href, "where the logo leads");
  for (const ring of focusRing.split(" ")) assert.ok(logo.classList.contains(ring), `the logo's focus ring: ${ring}`);
  assert.equal(logo.getAttribute("aria-current"), current ? "page" : null, "the logo is the page shown");
  assert.equal(logo.getAttribute("aria-label"), name, "the logo's name");
  const label = logo.querySelector("span > span")?.textContent ?? "";
  assert.equal(label, "designIQ", "the logo's label");
  assert.ok(name.startsWith(label), "the name starts with the label");
}

test("on the start page the logo leads to the list of repositories", async () => {
  const { logo } = await mount("/");
  assertLogo(logo(), "/", true, "designIQ: all repositories");
});

test("on a repository's overview, in a folder of it and in its editors the logo leads to its root overview", async () => {
  for (const [location, current] of [
    ["/r/acme/models", true],
    ["/r/acme/models?dir=sub%2Fdeeper", false],
    ["/r/acme/models/p/order-to-cash?element=Task_1", false],
    ["/r/acme/models/f/maps/landscape.wmap", false],
  ] as const) {
    const { logo } = await mount(location);
    assertLogo(logo(), "/r/acme/models", current, "designIQ: acme/models home");
    for (const cleanup of cleanups.splice(0)) cleanup();
  }
});

test("the logo follows the address to another repository and back to the start page", async () => {
  const { router, logo } = await mount("/r/acme/models/f/maps/landscape.wmap");
  await router.navigate({
    to: "/r/$owner/$repo/p/$processId",
    params: { owner: "Miragon", repo: "design-iq", processId: "checkout" },
  });
  await settle();
  assertLogo(logo(), "/r/Miragon/design-iq", false, "designIQ: Miragon/design-iq home");
  await router.navigate({ to: "/" });
  await settle();
  assertLogo(logo(), "/", true, "designIQ: all repositories");
});

test("the overview links to the list of repositories, at its root and in a folder, with the CI focus ring", async () => {
  for (const location of ["/r/acme/models", "/r/acme/models?dir=sub%2Fdeeper"]) {
    const { host } = await mount(location);
    const main = host.querySelector("main");
    assert.ok(main, `${location}: the page`);
    assert.ok(main.querySelector("h1")?.textContent?.includes("acme/models"), `${location}: the overview`);
    const inFolder = location.includes("?dir=");
    assert.equal(!!main.querySelector('nav[aria-label="Folder"]'), inFolder, `${location}: the folder's breadcrumb`);
    const links = [...main.querySelectorAll<HTMLAnchorElement>('a[href="/"]')];
    assert.equal(links.length, 1, `${location}: one link to the list`);
    const [list] = links as [HTMLAnchorElement];
    assert.equal(list.textContent?.trim(), "Repositories", `${location}: named by its text`);
    for (const ring of focusRing.split(" ")) assert.ok(list.classList.contains(ring), `${location}: ${ring}`);
    for (const cleanup of cleanups.splice(0)) cleanup();
  }
});
