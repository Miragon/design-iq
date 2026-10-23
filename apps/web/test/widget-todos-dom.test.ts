/**
 * The widget's Add todo form (src/mcp-app/todos.ts, #313) under jsdom on the
 * real skeleton (mcp-app.html), against a host that records its tool calls:
 * a repo's single template shows its fields without a picker and flags a
 * missing required one inline before anything is filed; with the built-in
 * `Todo` on offer, the picker appears and the built-in files today's request.
 * The Miragon skeleton (mcp-app-miragon.html) carries the same card, on the
 * element-surface controller (lib/todo-surface-canvas.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import type { TodoWire } from "@designiq/contracts/live-host";
import { BUILT_IN_TODO_TYPE, type TodoType } from "@designiq/contracts/todo-types";
import { JSDOM } from "jsdom";

import type { TodoCanvas, TodoCanvasHooks } from "../src/lib/todo-canvas.ts";
import { closeDom } from "./renderer-dom.ts";

after(closeDom);

const REF = { repo: "acme/models", path: "processes/order.bpmn" };
const BUG: TodoType = {
  id: "bug",
  name: "Bug report",
  description: "",
  titlePrefix: "[Bug]: ",
  fields: [
    {
      id: "hint",
      kind: "markdown",
      label: "",
      description: null,
      placeholder: null,
      value: "Thanks!",
      options: [],
      multiple: false,
      required: false,
    },
    {
      id: "repro",
      kind: "textarea",
      label: "Steps to reproduce",
      description: null,
      placeholder: null,
      value: null,
      options: [],
      multiple: false,
      required: true,
    },
  ],
};

const tick = () => new Promise((r) => setTimeout(r, 0));

interface WidgetOptions {
  skeleton?: "mcp-app.html" | "mcp-app-miragon.html";
  notation?: string;
  noun?: string;
  ref?: { repo: string; path: string };
  /** what list_todos answers */
  listed?: TodoWire[];
  /** the engine's canvas controller; default: bpmn's on a do-nothing modeler */
  canvas?: (hooks: TodoCanvasHooks, doc: Document) => TodoCanvas;
  /** open the Add todo form right away (the form tests) */
  open?: boolean;
}

async function widget(types: TodoType[], opts: WidgetOptions = {}) {
  const ref = opts.ref ?? REF;
  const html = readFileSync(new URL(`../${opts.skeleton ?? "mcp-app.html"}`, import.meta.url), "utf8").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  const { window } = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLTextAreaElement",
    "Element",
    "Node",
    "KeyboardEvent",
    "MouseEvent",
    "Event",
    "CSS",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
    Object.defineProperty(globals, key, {
      value: (window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  globals.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const reply = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const app = {
    addEventListener() {},
    getHostContext: () => ({ displayMode: "inline", availableDisplayModes: ["inline"] }),
    getHostCapabilities: () => ({ openLinks: {} }),
    requestDisplayMode: async () => ({ mode: "inline" }),
    sendSizeChanged: async () => ({}),
    updateModelContext: async () => ({}),
    callServerTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(request);
      if (request.name === "list_todos") return reply({ todos: opts.listed ?? [] });
      if (request.name === "list_todo_types") return reply({ types });
      return reply({
        todo: {
          id: "1",
          url: "https://tracker.test/1",
          title: request.arguments.title,
          body: "",
          state: "open",
          anchor: null,
          author: "petra",
          assignees: [],
          createdAt: "2026-10-23T00:00:00Z",
        },
      });
    },
  };
  const { mountChrome } = await import("../src/mcp-app/shell.ts");
  const { mountTodos } = await import("../src/mcp-app/todos.ts");
  const { attachTodoCanvas } = await import("../src/lib/todo-canvas.ts");
  const noun = opts.noun ?? "process";
  const chrome = mountChrome({
    app: app as never,
    notation: opts.notation ?? "bpmn",
    noun,
    readonly: false,
    actions: {
      save() {},
      reload() {},
      flushNow: async () => {},
      openInDesignIQ() {},
      deepLink: () => false,
      retry() {},
      askAssistant() {},
      state: () => ({ dirty: false, live: true, saving: false, paused: false, inactive: false, editable: true }),
      displayName: () => undefined,
      modelerMenu: () => undefined,
    },
  });
  const service = { remove() {}, add() {}, get: () => undefined, select() {}, scrollToElement() {} };
  const modeler = { raw: { get: () => service, on() {}, off() {} } };
  const doc = window.document;
  const todos = mountTodos(
    app as never,
    (hooks) => (opts.canvas ? opts.canvas(hooks, doc) : attachTodoCanvas(modeler.raw as never, hooks)),
    { readonly: false, chrome, noun },
  );
  todos.load(ref);
  todos.landed(ref);
  await tick();
  await tick();
  const byId = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  if (opts.open !== false) byId<HTMLButtonElement>("todo-new").click();
  const submit = async () => {
    byId<HTMLFormElement>("todo-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
    await tick();
  };
  const created = () => calls.filter((c) => c.name === "create_todo").map((c) => c.arguments);
  return { doc, byId, submit, created, window };
}

test("a single template: no picker, its fields, a missing required field flagged inline and nothing filed", async () => {
  const w = await widget([BUG]);
  assert.equal(w.byId("todo-type").hidden, true);
  assert.equal(w.byId("todo-type-name").textContent, "Filed as Bug report");
  assert.equal(w.byId("todo-body").hidden, true, "the plain description gives way to the form's fields");
  const repro = w.doc.querySelector<HTMLTextAreaElement>("#todo-fields textarea")!;
  assert.ok(repro);
  assert.equal(w.doc.querySelectorAll("#todo-fields .todo-field").length, 1, "the markdown hint is not a field");

  w.byId<HTMLInputElement>("todo-title").value = "Saving fails";
  await w.submit();
  assert.deepEqual(w.created(), []);
  const flag = w.doc.getElementById(repro.getAttribute("aria-describedby")!)!;
  assert.equal(flag.textContent, "Required");
  assert.equal(repro.getAttribute("aria-invalid"), "true");

  repro.value = "Click save";
  repro.dispatchEvent(new w.window.Event("input"));
  assert.equal(repro.getAttribute("aria-invalid"), null, "filling the field clears its flag");
  await w.submit();
  assert.deepEqual(w.created(), [
    { ...REF, title: "Saving fails", type: "bug", fields: { repro: "Click save" }, elements: [] },
  ]);
});

test("the built-in Todo beside a template: the picker shows, and the built-in files today's request", async () => {
  const w = await widget([BUILT_IN_TODO_TYPE, BUG]);
  const picker = w.byId<HTMLSelectElement>("todo-type");
  assert.equal(picker.hidden, false);
  assert.deepEqual(
    [...picker.options].map((o) => o.textContent),
    ["Todo", "Bug report"],
  );
  assert.equal(w.byId("todo-body").hidden, false);

  w.byId<HTMLInputElement>("todo-title").value = "Check the limit";
  w.byId<HTMLTextAreaElement>("todo-body").value = "  Looks stale ";
  await w.submit();
  assert.deepEqual(w.created(), [{ ...REF, title: "Check the limit", body: "Looks stale", elements: [] }]);

  w.byId<HTMLButtonElement>("todo-new").click();
  picker.value = "bug";
  picker.dispatchEvent(new w.window.Event("change"));
  assert.equal(w.byId("todo-body").hidden, true);
  assert.equal(w.doc.querySelectorAll("#todo-fields .todo-field").length, 1);
});

test("a repo without templates: the form is the plain todo it always was, an empty title is flagged", async () => {
  const w = await widget([BUILT_IN_TODO_TYPE]);
  assert.equal(w.byId("todo-type").hidden, true);
  assert.equal(w.byId("todo-type-name").hidden, true);
  assert.equal(w.byId("todo-body").hidden, false);
  assert.equal(w.byId("todo-fields").hidden, true);

  await w.submit();
  assert.equal(w.byId("todo-form-error").textContent, "A title is required.");
  assert.equal(w.byId("todo-title").getAttribute("aria-invalid"), "true");

  w.byId<HTMLInputElement>("todo-title").value = "Check the limit";
  await w.submit();
  assert.equal(w.byId("todo-form-error").hidden, true);
  assert.deepEqual(w.created(), [{ ...REF, title: "Check the limit", elements: [] }]);
});

test("a Miragon widget carries the card: its toggle and words, badges and the selection on the element surface", async () => {
  const anchored = (id: string, elements: Array<{ id: string; name: string }>): TodoWire => ({
    id,
    url: `https://tracker.test/${id}`,
    title: `Todo ${id}`,
    body: "",
    state: "open",
    anchor: { notation: "wardley", model: "tea", file: "maps/tea.owm", elements, processVersion: null },
    author: "petra",
    assignees: [],
    createdAt: "2026-10-23T00:00:00Z",
  });
  let select: (ids: string[]) => void = () => {};
  const { attachSurfaceTodoCanvas } = await import("../src/lib/todo-surface-canvas.ts");
  const w = await widget([BUILT_IN_TODO_TYPE], {
    skeleton: "mcp-app-miragon.html",
    notation: "wardley",
    noun: "Wardley Map",
    ref: { repo: "acme/models", path: "maps/tea.owm" },
    // one todo an agent anchored by the component's NAME, one on the whole map
    listed: [anchored("1", [{ id: "Kettle", name: "Kettle" }]), anchored("2", [])],
    open: false,
    canvas: (hooks, doc) =>
      attachSurfaceTodoCanvas(
        {
          get: () => ({ getContainer: () => doc.getElementById("canvas")!, viewbox: () => ({ x: 0, y: 0, scale: 1 }) }),
          on() {},
          off() {},
        },
        {
          list: () => [
            { id: "cmp_kettle", name: "Kettle" },
            { id: "cmp_tea", name: "Tea" },
          ],
          reveal: () => true,
          onSelection(cb) {
            select = cb;
            return () => {};
          },
          bounds: (id) => (id === "cmp_kettle" ? { x: 100, y: 50, width: 30, height: 30 } : undefined),
        },
        hooks,
      ),
  });
  const toggle = w.byId<HTMLButtonElement>("todo-toggle");
  assert.equal(toggle.hidden, false, "the toggle arrives with the canvas, once the tracker answered");
  assert.equal(toggle.title, "Open todos for this Wardley Map");
  assert.deepEqual(
    [...w.doc.querySelectorAll("#canvas .designiq-todo-badge")].map((b) => b.textContent),
    ["1"],
    "the agent's todo badges its component",
  );

  toggle.click();
  await tick();
  assert.deepEqual(
    [...w.doc.querySelectorAll("#todo-list .chip.whole")].map((c) => c.textContent),
    ["Whole Wardley Map"],
  );

  select(["cmp_tea"]);
  w.byId<HTMLButtonElement>("todo-new").click();
  assert.match(w.byId("todo-anchor").textContent ?? "", /Tea/);
  w.byId<HTMLInputElement>("todo-title").value = "Tea is a commodity";
  await w.submit();
  assert.deepEqual(w.created(), [
    {
      repo: "acme/models",
      path: "maps/tea.owm",
      title: "Tea is a commodity",
      elements: [{ id: "cmp_tea", name: "Tea" }],
    },
  ]);
});
