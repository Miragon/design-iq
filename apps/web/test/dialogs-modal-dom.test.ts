/**
 * The live editor's dialogs are modal to the keys: the zoom keys stay the
 * browser's under one (guide §5.8 takes a dialog for `aria-modal="true"`),
 * and Team Topology hears no key at all while one is open. Each dialog the
 * editor mounts (Release → PR, Create todo, the history diff, and Rename
 * and Duplicate through DialogShell) rendered with React under jsdom
 * (test/component-dom.ts), with the Monaco diff stubbed out: one
 * `role="dialog"` that is `aria-modal` and named by its title through
 * `aria-labelledby`. The canvas behind a dialog is out of reach in the
 * live editor itself (canvasInert, test/editor-view.test.ts), checked in the
 * built app by test/canvas-focus-chromium.ts.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, afterEach, test } from "node:test";

import { closeDom } from "./component-dom.ts";

after(closeDom);

// monaco-editor needs a browser to load; the dialog touches it only in the text view's effect
const STUB = [
  "const anything = () => new Proxy({}, { get: () => () => ({ setModel() {}, dispose() {} }) });",
  "export const editor = anything();",
  "export const languages = anything();",
].join("\n");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "monaco-editor") return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true };
  },
});

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { DialogShell } = await import("../src/components/dialog-shell.tsx");
const { HistoryDiffDialog } = await import("../src/components/history-diff-dialog.tsx");
const { ReleaseDialog } = await import("../src/components/release-dialog.tsx");
const { TodoCreateDialog } = await import("../src/components/todo-create-dialog.tsx");

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
const noop = (): void => {};

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await settle();
});

/** the dialog rendered into the document, the way the live editor mounts it */
async function render(dialog: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(createElement(QueryClientProvider, { client }, dialog));
  await settle();
  cleanups.push(() => {
    root.unmount();
    client.clear();
    host.remove();
  });
  return host;
}

function assertModalDialog(host: HTMLElement, title: string): void {
  const dialogs = host.querySelectorAll('[role="dialog"]');
  assert.equal(dialogs.length, 1, "one dialog");
  const dialog = dialogs[0]!;
  assert.equal(dialog.getAttribute("aria-modal"), "true", "aria-modal");
  const labelId = dialog.getAttribute("aria-labelledby");
  assert.ok(labelId, "aria-labelledby");
  assert.equal(document.getElementById(labelId)?.textContent, title, "named by its title");
}

test("Release → PR is a modal dialog named by its title", async () => {
  assertModalDialog(
    await render(createElement(ReleaseDialog, { repo: "acme/models", preselect: [], onClose: noop })),
    "Release → PR",
  );
});

test("Create todo is a modal dialog named by its title", async () => {
  assertModalDialog(
    await render(
      createElement(TodoCreateDialog, {
        repo: "acme/models",
        model: { notation: "wardley", id: "tea" },
        noun: "Wardley Map",
        docPath: "models/tea.wmap",
        elements: [],
        onClose: noop,
      }),
    ),
    "Create todo",
  );
});

test("the history diff is a modal dialog named by its commit", async () => {
  assertModalDialog(
    await render(
      createElement(HistoryDiffDialog, {
        commit: { sha: "0123456789abcdef", subject: "Rename the kettle" },
        historical: "title Tea\n",
        current: "title Tea Shop\n",
        language: "plaintext",
        restorePending: false,
        onRestore: noop,
        onClose: noop,
      } as never),
    ),
    "0123456 · Rename the kettle",
  );
});

test("Rename and Duplicate, which DialogShell draws, are modal dialogs named by their title", async () => {
  assertModalDialog(
    await render(
      createElement(DialogShell, {
        title: "Rename model",
        pending: false,
        submitLabel: "Rename",
        pendingLabel: "Renaming…",
        onSubmit: noop,
        onClose: noop,
      }),
    ),
    "Rename model",
  );
});
