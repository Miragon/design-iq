/**
 * The live editor's dialogs are modal: the zoom keys stay the browser's
 * under one (guide §5.8 takes a dialog for a modal one), and Team Topology
 * hears no key at all while one is open. Each dialog the editor mounts
 * (Release → PR, Create todo, the history diff, and Rename and Duplicate
 * through DialogShell) rendered with React under jsdom (test/component-dom.ts),
 * with the Monaco diff stubbed out: one native <dialog> shown with
 * showModal(), so the page behind it is inert in a browser, `aria-modal` for
 * the checks that cannot ask for `:modal`, named by its title through
 * `aria-labelledby`, and holding the focus as it opens. That the toolbar,
 * the source and the canvas are out of reach behind one, and the focus goes
 * back as it closes, is checked in the built app by
 * test/canvas-focus-chromium.ts.
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

// test/renderer-dom.ts opens a dialog on showModal() as on show(): only this tells the two apart
const shownModal = new WeakSet<Element>();
const { showModal } = HTMLDialogElement.prototype;
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  shownModal.add(this);
  showModal.call(this);
};

const { createElement } = await import("react");
const { flushSync } = await import("react-dom");
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

/** the dialog rendered into the document, the way the live editor mounts it, and committed */
function render(dialog: ReturnType<typeof createElement>): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  // no garbage collection timers: the default five minutes keep node running long after the last case
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  flushSync(() => root.render(createElement(QueryClientProvider, { client }, dialog)));
  cleanups.push(() => {
    root.unmount();
    client.clear();
    host.remove();
  });
  return host;
}

/** `focused` picks, from the dialog, what holds the focus as it opens */
function assertModalDialog(host: HTMLElement, title: string, focused: (dialog: Element) => Element | null): void {
  const dialogs = host.querySelectorAll("dialog");
  assert.equal(dialogs.length, 1, "one dialog");
  const dialog = dialogs[0]!;
  assert.ok(shownModal.has(dialog), "shown with showModal()");
  assert.equal(dialog.getAttribute("aria-modal"), "true", "aria-modal");
  const labelId = dialog.getAttribute("aria-labelledby");
  assert.ok(labelId, "aria-labelledby");
  assert.equal(document.getElementById(labelId)?.textContent, title, "named by its title");
  const target = focused(dialog);
  assert.ok(target, "the element to focus is there");
  assert.equal(document.activeElement, target, "takes the focus as it opens");
}

test("Release → PR is a modal dialog named by its title, which takes the focus itself", () => {
  assertModalDialog(
    render(createElement(ReleaseDialog, { repo: "acme/models", preselect: [], onClose: noop })),
    "Release → PR",
    (dialog) => dialog,
  );
});

test("Create todo is a modal dialog named by its title, which opens on the title field", () => {
  assertModalDialog(
    render(
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
    (dialog) => dialog.querySelector("#todo-title"),
  );
});

test("the history diff is a modal dialog named by its commit, which opens on Close", () => {
  assertModalDialog(
    render(
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
    (dialog) => dialog.querySelector('button[title="Close"]'),
  );
});

test("Rename and Duplicate, which DialogShell draws, are modal dialogs named by their title, on their field", () => {
  assertModalDialog(
    render(
      createElement(
        DialogShell,
        {
          title: "Rename model",
          pending: false,
          submitLabel: "Rename",
          pendingLabel: "Renaming…",
          onSubmit: noop,
          onClose: noop,
        },
        createElement("input", { id: "rename-model-name", "data-autofocus": true }),
      ),
    ),
    "Rename model",
    (dialog) => dialog.querySelector("#rename-model-name"),
  );
});

test("a destructive dialog DialogShell draws opens on Cancel (guide §8)", () => {
  assertModalDialog(
    render(
      createElement(DialogShell, {
        title: "Delete model?",
        pending: false,
        destructive: true,
        submitLabel: "Delete",
        pendingLabel: "Deleting…",
        onSubmit: noop,
        onClose: noop,
      }),
    ),
    "Delete model?",
    (dialog) => [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel") ?? null,
  );
});

test("Escape and a click on the backdrop dismiss a dialog, a click in its panel does not, and the browser never closes it", () => {
  const dismissed: string[] = [];
  const host = render(
    createElement(DialogShell, {
      title: "Rename model",
      pending: false,
      submitLabel: "Rename",
      pendingLabel: "Renaming…",
      onSubmit: noop,
      onClose: () => dismissed.push("close"),
    }),
  );
  const dialog = host.querySelector("dialog")!;
  dialog.querySelector("form")!.click();
  assert.deepEqual(dismissed, [], "a click in the panel");
  dialog.click();
  assert.deepEqual(dismissed, ["close"], "a click on the backdrop");
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  dialog.dispatchEvent(escape);
  assert.deepEqual(dismissed, ["close", "close"], "Escape");
  assert.equal(escape.defaultPrevented, true, "Escape is not left to the browser, which would close the dialog itself");
  const cancel = new Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true, "the browser's cancel is held");
  assert.equal(dialog.hasAttribute("open"), true, "it stays open until the editor unmounts it");
});

test("while the action runs, neither Escape nor the backdrop dismisses a dialog", () => {
  const dismissed: string[] = [];
  const host = render(
    createElement(DialogShell, {
      title: "Rename model",
      pending: true,
      submitLabel: "Rename",
      pendingLabel: "Renaming…",
      onSubmit: noop,
      onClose: () => dismissed.push("close"),
    }),
  );
  const dialog = host.querySelector("dialog")!;
  dialog.click();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  dialog.dispatchEvent(escape);
  assert.deepEqual(dismissed, []);
  assert.equal(escape.defaultPrevented, true, "and the browser does not close it either");
});
