/**
 * The BPMN modeler widget — the bpmn engine on the shared widget core
 * (core/widget.ts + core/lifecycle.ts: App handshake → tool input → load the
 * live document → engine → CAS autosave with the conflict decision → live
 * upgrade). What is BPMN here: the sticky/t.BPM modules inside the engine,
 * the Workshop chip-switch (TL, chrome/mode-chip.ts) and its menu checkbox,
 * the Todos card + canvas badges (todos.ts on chrome/panel.ts), the process
 * deep link carrying the canvas selection, and the inlined bpmn icon font.
 */
import "./styles.css";

import { processDeepLink } from "@designiq/contracts/deep-link";
import { modelStem } from "@designiq/notations";

import { attachTodoCanvas } from "@/lib/todo-canvas";
import { tbpmToggleAction } from "@/notations/bpmn-sticky";

import type { ModeChip } from "./chrome/contracts";
import { bootWidget } from "./core/widget";
import { type BpmnEngine, mountBpmnEngine } from "./engines/bpmn";
import { mountTodos } from "./todos";

bootWidget<BpmnEngine>({
  notation: "bpmn",
  noun: "model",
  engine: mountBpmnEngine,
  fonts: ["bpmn"],
  // the process route, carrying the canvas selection (?element=)
  deepLink: (publicUrl, doc, engine) =>
    processDeepLink(publicUrl, doc.repo, modelStem(doc.path), engine.selectedElementId?.()),
  extras: ({ app, engine, readonly, chrome }) => {
    // t.BPM (#117): the same document-property flip as the web editor's
    // header toggle — a facilitator can start a workshop from the widget
    if (engine.editable) chrome.setModeChip(workshopChip(engine));
    // bound BEFORE the first import: the canvas controller re-renders its
    // badges on every `import.done` (incl. the live re-imports)
    const todos = mountTodos(app, (hooks) => attachTodoCanvas(engine.raw as never, hooks), {
      readonly,
      chrome,
      noun: "process",
    });
    return {
      // discovery at the read, in parallel with the import; the toggle
      // arrives with the canvas
      onRead: (doc) => todos.load(doc),
      onDocument: (doc) => todos.landed(doc),
      destroy: () => {
        todos.destroy();
        chrome.setModeChip(undefined);
      },
    };
  },
});

/** the widget twin of the web editor's t.BPM header switch: the TL chip and
 *  the menu checkbox share this one action */
function workshopChip(engine: BpmnEngine): ModeChip {
  const action = tbpmToggleAction(engine.raw as never);
  return {
    label: action.label,
    title: action.buttonTitle,
    isOn: () => action.isActive?.() ?? false,
    toggle: () => action.run(),
    onChanged: (cb) => action.onChanged?.(cb) ?? (() => {}),
  };
}
