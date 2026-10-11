/**
 * The Todos card (spec §7.1): the same model-anchored work items the web SPA
 * shows (components/todo-panel.tsx), driven over the app bridge instead of
 * REST — list_todos / create_todo / close_todo on the Live Host's /mcp. The
 * card shell (one panel at a time, focus, Escape, the sheet when compact, the
 * toggle's count chip) is chrome/panel.ts behind chrome.registerPanel; this
 * module fills it. What the list area shows and every outcome's copy is
 * core/todos-view.ts.
 *
 * Canvas integration is the SHARED controller (lib/todo-canvas.ts): count
 * badges per anchored element, badge click → the card filtered to it,
 * selection → the anchor a new todo gets. It re-renders on every `import.done`,
 * so live (Yjs) re-imports keep their badges.
 *
 * Capability-driven, never assumed: the todo tools are absent without a
 * configured tracker, and the write ones in read-only mode. Discovery starts
 * at the read (WidgetExtras.onRead), in parallel with the import; the toggle
 * appears with the canvas. The first list call decides — a missing tool keeps
 * the feature away for good (isMissingTool), any other failure is a real
 * tracker error, shown verbatim (permission messages are actionable).
 *
 * Where each outcome lands: a load or close failure → ONE callout (load: with
 * Try again); a create failure → under the form; Implement and a blocked
 * tracker link → toasts; a write tool turning out absent → the read-only foot
 * line, write actions removed. The modeler itself is never blocked by any of it.
 */
import type { TodoElementWire, TodoWire } from "@designiq/contracts/live-host";
import type { App } from "@modelcontextprotocol/ext-apps";

import { attachTodoCanvas, type TodoCanvas } from "@/lib/todo-canvas";
import { closeInTrackerTitle, elementLabel, openInTrackerTitle } from "@/lib/todo-view";

import { closeTodo, createTodo, isMissingTool, listTodos } from "./bridge";
import type { PanelHandle, WidgetChrome } from "./chrome/contracts";
import { h } from "./chrome/dom";
import {
  addTodoTitle,
  anchorLabel,
  anchorTitle,
  closeError,
  createError,
  filedAgo,
  headCount,
  IMPLEMENT_TITLE,
  implementRefused,
  implementSent,
  linkBlocked,
  loadError,
  READONLY_FOOT,
  todoListView,
  todoMeta,
  todosBadge,
  WHOLE_PROCESS,
  WHOLE_PROCESS_TITLE,
} from "./core/todos-view";
import type { BpmnEngine } from "./engines/bpmn";
import { icon } from "./icons";
import { el, openExternal } from "./shell";
import { implementPrompt, type PromptTarget } from "./todo-prompt";

export interface TodosHandle {
  /** the document is known (WidgetExtras.onRead): list its todos now, in
   *  parallel with the import — the badges are there before the card opens */
  load(ref: PromptTarget): void;
  /** the canvas landed (WidgetExtras.onDocument): the toggle may appear */
  landed(ref: PromptTarget): void;
  destroy(): void;
}

export function mountTodos(
  app: App,
  modeler: BpmnEngine,
  opts: { readonly: boolean; chrome: WidgetChrome },
): TodosHandle {
  const { chrome } = opts;
  const toggle = el<HTMLButtonElement>("todo-toggle");
  const heading = el<HTMLElement>("todos-h");
  const countEl = el<HTMLSpanElement>("todo-count");
  const newBtn = el<HTMLButtonElement>("todo-new");
  const refreshBtn = el<HTMLButtonElement>("todo-refresh");
  const filterBar = el<HTMLDivElement>("todo-filter");
  const filterChip = el<HTMLButtonElement>("todo-filter-name");
  const errorEl = el<HTMLDivElement>("todo-error");
  const errorText = el<HTMLSpanElement>("todo-error-text");
  const retryBtn = el<HTMLButtonElement>("todo-retry");
  const form = el<HTMLFormElement>("todo-form");
  const anchorEl = el<HTMLDivElement>("todo-anchor");
  const titleInput = el<HTMLInputElement>("todo-title");
  const bodyInput = el<HTMLTextAreaElement>("todo-body");
  const formError = el<HTMLParagraphElement>("todo-form-error");
  const submitBtn = el<HTMLButtonElement>("todo-submit");
  const listEl = el<HTMLDivElement>("todo-list");
  /** the card's one scroller: the callout, the form and the list */
  const scroller = el<HTMLDivElement>("todo-scroll");
  const foot = el<HTMLParagraphElement>("todo-foot");
  foot.append(icon("info", 14), READONLY_FOOT);

  let ref: PromptTarget | undefined;
  let todos: TodoWire[] = [];
  let selection: TodoElementWire[] = [];
  let filter: string | null = null; // element id a badge click narrowed to
  /** the ONE callout: a failed list (with Try again) or a failed close */
  let error: { text: string; retry: boolean } | undefined;
  let failed = false; // the last list call failed — the callout replaces the empty text
  let loading = false;
  let creating = false;
  const closing = new Set<string>(); // todo ids with a close in flight
  const sending = new Set<string>(); // todo ids with an Implement in flight
  let absent = false; // no tracker on this host — the feature stays away
  let discovered = false; // a list call came back — only THEN is the toggle real
  let landed = false; // the canvas is there — the toggle arrives with it
  let canWrite = !opts.readonly; // flipped off if create/close turn out absent
  let keepOnOpen = false; // a badge or a collapsed sheet reopens as it was
  let epoch = 0; // bumps on load() — stale async results bail out

  const panel: PanelHandle = chrome.registerPanel({
    id: "todos",
    panel: el<HTMLElement>("todos"),
    toggle,
    heading,
    escape: () => closeForm(true),
    onOpen() {
      if (keepOnOpen) keepOnOpen = false;
      else {
        filter = null;
        void refresh(); // the tracker moves outside this widget — re-read on open
      }
      render();
    },
    onClose() {
      keepOnOpen = false;
      closeForm(false);
    },
  });

  const canvas: TodoCanvas = attachTodoCanvas(modeler.raw as never, {
    onBadgeClick: (elementId) => {
      filter = elementId;
      if (panel.isOpen()) render();
      else {
        keepOnOpen = true;
        panel.open();
      }
    },
    onSelectionChanged: (elements) => {
      selection = elements;
      renderAnchor();
    },
  });

  // ── rendering ─────────────────────────────────────────────────────────────

  const chip = (label: string, title: string, cls = "chip"): HTMLElement => h("span", { class: cls, title }, label);
  const whole = (): HTMLElement => chip(WHOLE_PROCESS, WHOLE_PROCESS_TITLE, "chip whole");

  /** the form's anchor preview tracks the live selection; Add todo's title too */
  function renderAnchor(): void {
    newBtn.title = addTodoTitle(selection.length);
    if (form.hidden) return;
    anchorEl.replaceChildren(
      h("span", { class: "muted" }, "Anchored to:"),
      ...(selection.length === 0 ? [whole()] : selection.map((e) => chip(anchorLabel(e), e.id))),
    );
  }

  function renderRow(todo: TodoWire): HTMLElement {
    const busy = closing.has(todo.id);
    const row = h("div", { class: busy ? "todo busy" : "todo", role: "listitem" });
    if (busy) row.setAttribute("aria-busy", "true");
    // a BUTTON, not an <a target="_blank">: the app sandbox blocks navigation,
    // so the host opens the link for us (openTracker)
    const link = h(
      "button",
      { type: "button", class: "pb icon ghost todo-link", title: openInTrackerTitle(todo.id) },
      icon("external-link", 14),
    );
    link.setAttribute("aria-label", openInTrackerTitle(todo.id));
    link.dataset.focus = `${todo.id}:link`;
    link.onclick = () => void openTracker(todo.url);
    row.append(h("div", { class: "todo-head" }, h("span", { class: "todo-title" }, todo.title), link));
    // the description in two lines — it rides along in full when the todo is
    // handed to the assistant
    if (todo.body.trim()) row.append(h("p", { class: "todo-body" }, todo.body.trim()));

    const chips = h("div", { class: "todo-chips" });
    const elements = todo.anchor?.elements ?? [];
    if (elements.length === 0) chips.append(whole());
    for (const element of elements) {
      const button = h("button", { type: "button", class: "chip", title: anchorTitle(element) }, anchorLabel(element));
      button.dataset.focus = `${todo.id}:chip:${element.id}`;
      button.onclick = () => reveal(element, button);
      chips.append(button);
    }
    row.append(chips);

    const meta = h("span", { class: "todo-meta" }, todoMeta(todo));
    const age = filedAgo(todo.createdAt);
    if (age) meta.title = age;
    const footRow = h("div", { class: "todo-foot" }, meta);
    if (canWrite) {
      // hand the work to the assistant instead of doing it by hand — the
      // prompt carries the whole order (read → edit → validate → save → close)
      const implement = h("button", { type: "button", class: "pb link", title: IMPLEMENT_TITLE }, icon("send", 14));
      implement.append("Implement");
      // aria-disabled, not disabled: the control keeps keyboard focus while
      // its call is in flight (the handlers guard against a second one)
      if (busy || sending.has(todo.id)) implement.setAttribute("aria-disabled", "true");
      implement.dataset.focus = `${todo.id}:implement`;
      implement.onclick = () => void handOver(todo);
      const done = h(
        "button",
        { type: "button", class: "pb ghost", title: closeInTrackerTitle(todo.id) },
        busy ? icon("loader-circle", 14, "spin") : icon("check", 14),
        busy ? "Closing…" : "Done",
      );
      if (busy) done.setAttribute("aria-disabled", "true");
      done.dataset.focus = `${todo.id}:done`;
      done.onclick = () => void complete(todo.id);
      footRow.append(implement, done);
    }
    row.append(footRow);
    return row;
  }

  /** the list area: exactly one of skeleton, rows, the empty states — or
   *  nothing under the error callout */
  function renderList(): void {
    const view = todoListView({ todos, filter, loading, failed, canWrite });
    const nodes: HTMLElement[] = [];
    switch (view.kind) {
      case "loading": {
        const bar = (cls: string): HTMLElement => h("span", { class: `bar ${cls}` });
        const ghost = (): HTMLElement =>
          h("div", { class: "todo skeleton", "aria-hidden": "true" }, bar("w70"), bar("w40"), bar("w30"));
        nodes.push(
          ghost(),
          ghost(),
          h("p", { class: "todo-loading", role: "status" }, icon("loader-circle", 14, "spin"), view.text),
        );
        break;
      }
      case "rows":
        nodes.push(...view.rows.map(renderRow));
        break;
      case "filtered-empty": {
        const all = h("button", { type: "button", class: "pb" }, "Show all");
        all.onclick = () => clearFilter();
        nodes.push(h("div", { class: "todo-empty" }, h("p", { class: "todo-empty-title" }, view.title), all));
        break;
      }
      case "empty": {
        const box = h(
          "div",
          { class: "todo-empty" },
          icon("list-todo", 24),
          h("p", { class: "todo-empty-title" }, view.title),
        );
        if (view.hint) box.append(h("p", { class: "todo-empty-hint" }, view.hint));
        if (view.add && form.hidden) {
          const add = h("button", { type: "button", class: "pb", title: addTodoTitle(selection.length) });
          add.append(icon("list-plus", 14), "Add todo");
          add.onclick = () => openForm();
          box.append(add);
        }
        nodes.push(box);
        break;
      }
      case "error":
        break; // the callout above says it all
    }
    // a re-render (a refresh, a closed row) keeps the reader where they were —
    // the scroll offset, and keyboard focus on the same control of the same
    // row (its row gone: the heading, never <body>)
    const top = scroller.scrollTop;
    const focused = document.activeElement;
    const key = focused instanceof HTMLElement && listEl.contains(focused) ? (focused.dataset.focus ?? "") : undefined;
    listEl.replaceChildren(...nodes);
    scroller.scrollTop = top;
    if (key !== undefined) {
      const same = key ? listEl.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`) : null;
      if (same && !(same as HTMLButtonElement).disabled) same.focus({ preventScroll: true });
      else heading.focus({ preventScroll: true });
    }
    if (view.kind === "rows") listEl.setAttribute("role", "list");
    else listEl.removeAttribute("role");
    listEl.setAttribute("aria-busy", String(loading));
  }

  function render(): void {
    panel.setAvailable(discovered && landed && !absent);
    panel.setBadge(todosBadge(todos.length, failed));
    // a count only once there is something to count — the empty, loading
    // and error states say it in words
    countEl.textContent = todos.length === 0 ? "" : headCount(todos, filter);
    newBtn.hidden = !canWrite;
    newBtn.setAttribute("aria-expanded", String(!form.hidden));
    // aria-disabled, not disabled: a disabled button drops its focus to <body>
    // mid-refresh (refresh() guards on `loading`)
    if (loading) refreshBtn.setAttribute("aria-disabled", "true");
    else refreshBtn.removeAttribute("aria-disabled");
    // a load error steps aside while its own retry runs — the skeleton speaks
    hide(errorEl, error === undefined || (error.retry && loading));
    errorText.textContent = error?.text ?? "";
    retryBtn.hidden = !error?.retry;
    hide(filterBar, filter === null);
    if (filter !== null) {
      // the creation-time name snapshot keeps the chip readable after a rename
      const name = elementLabel(todos, filter);
      filterChip.replaceChildren(h("span", { class: "chip-label" }, name), icon("x", 12));
      filterChip.title = "Show all todos";
      filterChip.setAttribute("aria-label", `Filtered to ${name} — show all todos`);
    }
    foot.hidden = canWrite;
    renderList();
    canvas.setTodos(todos);
  }

  /** hide a row of the card; focus on a control inside it moves to the
   *  heading instead of falling back to <body> */
  function hide(node: HTMLElement, hidden: boolean): void {
    if (hidden && !node.hidden && node.contains(document.activeElement)) heading.focus({ preventScroll: true });
    node.hidden = hidden;
  }

  function clearFilter(): void {
    filter = null;
    render();
    heading.focus({ preventScroll: true }); // the control that had focus is gone
  }

  // ── the inline form ───────────────────────────────────────────────────────

  function openForm(): void {
    if (!canWrite) return;
    form.hidden = false;
    formError.hidden = true;
    renderAnchor();
    render();
    titleInput.focus();
  }

  /** the panel's own Escape layer: true when there was a form to close */
  function closeForm(returnFocus: boolean): boolean {
    if (form.hidden) return false;
    const hadFocus = form.contains(document.activeElement);
    form.hidden = true;
    newBtn.setAttribute("aria-expanded", "false");
    render();
    if (returnFocus && hadFocus && !newBtn.hidden) newBtn.focus();
    return true;
  }

  function setCreating(on: boolean): void {
    creating = on;
    // aria-disabled: a disabled button drops its focus to <body> mid-create
    // (submit() guards on `creating`)
    if (on) submitBtn.setAttribute("aria-disabled", "true");
    else submitBtn.removeAttribute("aria-disabled");
    submitBtn.replaceChildren(...(on ? [icon("loader-circle", 14, "spin"), "Creating…"] : ["Create todo"]));
  }

  // ── host actions (link, prompt, canvas) ───────────────────────────────────

  /** tracker links go through the shared host-open ladder (shell.ts) */
  async function openTracker(url: string): Promise<void> {
    await openExternal(app, url, () => chrome.toast(linkBlocked(url)));
  }

  /** an anchor chip selects its element; a compact sheet steps aside so the
   *  element shows — and the toggle brings it back where it was */
  function reveal(element: TodoElementWire, button: HTMLButtonElement): void {
    if (!canvas.reveal(element.id)) {
      // the anchor stays listed (the todo is still real work) — only the reveal is gone
      button.title = anchorTitle(element, true);
      button.classList.add("gone");
      return;
    }
    panel.collapse();
    if (!panel.isOpen()) keepOnOpen = true;
  }

  /** hand the todo to the assistant: inject the work order as a user message
   *  (`ui/message`) and step out of the way — the answer lands in the CHAT, so
   *  a fullscreen widget would otherwise hide the very thing it just asked for */
  async function handOver(todo: TodoWire): Promise<void> {
    if (!ref || sending.has(todo.id) || closing.has(todo.id)) return;
    const prompt = implementPrompt(todo, ref);
    const openIt = (): void => void openTracker(todo.url);
    sending.add(todo.id);
    render();
    try {
      const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
      if (result.isError) {
        chrome.toast(implementRefused(todo.id, openIt));
        return;
      }
      if (chrome.host().displayMode !== "inline") void chrome.requestDisplayMode("inline").catch(() => undefined);
      panel.close();
      chrome.toast(implementSent(todo.id));
    } catch (err) {
      chrome.toast(implementRefused(todo.id, openIt, (err as Error).message));
    } finally {
      sending.delete(todo.id);
      render();
    }
  }

  // ── tracker calls ─────────────────────────────────────────────────────────

  /** refresh from the tracker; the FIRST failure decides whether the feature
   *  exists at all on this host (absent → away, forever quiet) */
  async function refresh(): Promise<void> {
    // `loading` is per DOCUMENT: load() clears it, so a re-open never inherits
    // the previous document's in-flight call (that one bails on the epoch)
    if (!ref || absent || loading) return;
    const mine = epoch;
    loading = true;
    render();
    try {
      const result = await listTodos(app, ref);
      if (mine !== epoch) return; // another document owns the card now
      todos = result.todos;
      discovered = true;
      failed = false;
      error = undefined;
    } catch (err) {
      if (mine !== epoch) return;
      if (isMissingTool(err, "list_todos")) {
        absent = true;
        todos = [];
      } else {
        // the tracker exists but refused (permission, upstream outage) — the
        // message is actionable, so surface the feature WITH its error
        discovered = true;
        failed = true;
        error = { text: loadError((err as Error).message), retry: true };
      }
    } finally {
      if (mine === epoch) {
        loading = false;
        render();
      }
    }
  }

  async function complete(todoId: string): Promise<void> {
    if (!ref || closing.has(todoId)) return;
    const mine = epoch;
    closing.add(todoId);
    render();
    try {
      await closeTodo(app, ref.repo, todoId);
      if (mine !== epoch) return;
      // drop the row right away — badges and counts follow from the same list
      todos = todos.filter((t) => t.id !== todoId);
      if (!error?.retry) error = undefined;
      void app.updateModelContext({
        content: [{ type: "text", text: `User closed todo #${todoId} in ${ref.repo} from the modeler widget.` }],
      });
    } catch (err) {
      if (mine !== epoch) return;
      // read-only discovered: the foot line says it, the write actions go
      if (isMissingTool(err, "close_todo")) canWrite = false;
      else error = { text: closeError(todoId, (err as Error).message), retry: false };
    } finally {
      closing.delete(todoId); // the row restores on a failure
      if (mine === epoch) render();
    }
  }

  async function submit(): Promise<void> {
    const title = titleInput.value.trim();
    if (!ref || creating || title.length === 0) return;
    const mine = epoch;
    setCreating(true);
    formError.hidden = true;
    try {
      // the anchor is the selection at SUBMIT time — the preview above the
      // form tracks it live, so what the user last saw is what gets anchored
      const { todo } = await createTodo(app, ref, { title, body: bodyInput.value.trim(), elements: selection });
      if (mine !== epoch) return;
      todos = [todo, ...todos];
      titleInput.value = "";
      bodyInput.value = "";
      closeForm(true);
      void app.updateModelContext({
        content: [{ type: "text", text: `User filed todo #${todo.id} "${todo.title}" from the modeler widget.` }],
      });
    } catch (err) {
      if (mine !== epoch) return;
      if (isMissingTool(err, "create_todo")) {
        canWrite = false;
        closeForm(false);
        heading.focus({ preventScroll: true });
      } else {
        formError.textContent = createError((err as Error).message);
        formError.hidden = false;
      }
    } finally {
      setCreating(false);
      if (mine === epoch) render();
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  el<HTMLButtonElement>("todo-hide").onclick = () => panel.close();
  refreshBtn.onclick = () => void refresh();
  retryBtn.onclick = () => void refresh();
  filterChip.onclick = () => clearFilter();
  el<HTMLButtonElement>("todo-filter-clear").onclick = () => clearFilter();
  newBtn.onclick = () => (form.hidden ? openForm() : void closeForm(true));
  el<HTMLButtonElement>("todo-cancel").onclick = () => void closeForm(true);
  form.onsubmit = (e) => {
    e.preventDefault();
    void submit();
  };
  renderAnchor();

  function load(next: PromptTarget): void {
    epoch++;
    ref = next;
    todos = [];
    selection = [];
    filter = null;
    error = undefined;
    failed = false;
    loading = false;
    closing.clear();
    sending.clear();
    formError.hidden = true;
    closeForm(false);
    renderAnchor();
    render();
    void refresh(); // badges must be there before the card is ever opened
  }

  return {
    load,
    landed(next) {
      landed = true;
      if (!ref || ref.repo !== next.repo || ref.path !== next.path) load(next);
      else render();
    },
    destroy() {
      epoch++;
      canvas.destroy();
      closeForm(false);
      panel.setAvailable(false);
    },
  };
}
