/**
 * How the widget hands an export to the user (src/mcp-app/shell.ts
 * downloadExport): the sandbox blocks downloads, so the host saves the file
 * (`ui/download-file`, an embedded resource: text for SVG, base64 for PNG),
 * and every way it can go wrong — no such capability, a declined download,
 * a build that fails — ends in a toast, never in silence (guide §9).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { App } from "@modelcontextprotocol/ext-apps";

import type { ToastSpec } from "../src/mcp-app/core/lifecycle.ts";
import { closeDom } from "./renderer-dom.ts";

after(closeDom);

function fakeApp(capable: boolean, declined = false) {
  const requests: unknown[] = [];
  const app = {
    getHostCapabilities: () => (capable ? { downloadFile: {} } : {}),
    downloadFile: async (params: unknown) => {
      requests.push(params);
      return declined ? { isError: true } : {};
    },
  } as unknown as App;
  return { app, requests };
}

test("the host saves an SVG as text and a PNG as base64, named after the model", async () => {
  const { downloadExport } = await import("../src/mcp-app/shell.ts");
  const toasts: ToastSpec[] = [];
  const { app, requests } = fakeApp(true);
  await downloadExport(
    app,
    async () => ({ name: "tea shop.svg", mimeType: "image/svg+xml", data: "<svg/>" }),
    (t) => void toasts.push(t),
  );
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  await downloadExport(
    app,
    async () => ({ name: "tea-shop.png", mimeType: "image/png", data: png }),
    (t) => void toasts.push(t),
  );
  assert.deepEqual(requests, [
    {
      contents: [
        { type: "resource", resource: { uri: "file:///tea%20shop.svg", mimeType: "image/svg+xml", text: "<svg/>" } },
      ],
    },
    {
      contents: [
        { type: "resource", resource: { uri: "file:///tea-shop.png", mimeType: "image/png", blob: "iVBORw==" } },
      ],
    },
  ]);
  assert.deepEqual(toasts, [], "the host confirms a download itself");
});

test("no download capability, a declined download and a failed build each say so", async () => {
  const { downloadExport } = await import("../src/mcp-app/shell.ts");
  const toasts: ToastSpec[] = [];
  const file = async () => ({ name: "map.svg", mimeType: "image/svg+xml", data: "<svg/>" });
  const incapable = fakeApp(false);
  await downloadExport(incapable.app, file, (t) => void toasts.push(t));
  assert.deepEqual(incapable.requests, [], "nothing asked of a host that cannot");
  await downloadExport(fakeApp(true, true).app, file, (t) => void toasts.push(t));
  await downloadExport(
    fakeApp(true).app,
    async () => {
      throw new Error("the PNG could not be encoded");
    },
    (t) => void toasts.push(t),
  );
  assert.deepEqual(
    toasts.map((t) => [t.tone, t.title, t.detail]),
    [
      ["danger", "Your client cannot save files from this widget", "Open the model in designIQ to export it."],
      ["info", "map.svg was not saved", "Your client declined the download."],
      ["danger", "Export failed", "the PNG could not be encoded"],
    ],
  );
});
