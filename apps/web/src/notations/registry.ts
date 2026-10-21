/**
 * The web editor plugin registry (epic #118 step 6): which visual editor,
 * side panels, assist handoff and history diff a notation gets. The shell
 * (live-editor.tsx) looks its plugin up by descriptor id and mounts through
 * this contract — a notation WITHOUT a plugin opens in collaborative Monaco.
 * The "visual editor" may also be a read-only rendering: Markdown mounts a
 * live preview, and its source is edited in the shell's Monaco layer, where
 * a plugin may attach tooling of its own (Markdown: Insert diagram).
 *
 * Boundary rule, mirrored from ADR 0006: a plugin MANIFEST (this module +
 * the per-notation manifests it imports) is light, eager data — the editor
 * ENGINES (bpmn-js, dmn-js, the Miragon renderers, the differ) live behind
 * the manifests' dynamic imports, so the eager bundle never carries an engine
 * and the repo overview loads none of them. The Miragon renderers are not
 * hand-written manifests: ./miragon holds ONE spec per renderer, and
 * miragonPlugin derives the manifest from it.
 */
import type * as Monaco from "monaco-editor";
import type { ComponentType, LazyExoticComponent } from "react";
import type * as Y from "yjs";

import type { TodoElementWire } from "@/lib/api";
import type { PresenceSurface } from "@/lib/presence-canvas";
import type { TodoCanvas } from "@/lib/todo-canvas";
import type { ModelerMenu } from "@/mcp-app/core/menu-model";

import { bpmnPlugin } from "./bpmn";
import { dmnPlugin } from "./dmn";
import { markdownPlugin } from "./markdown/plugin";
import { MIRAGON_RENDERERS } from "./miragon";
import { miragonPlugin } from "./miragon/plugin";

/** what the shell hands a mounting editor engine */
export interface EditorContext {
  /** the ONE shared live document (text shape) */
  ytext: Y.Text;
  doc: Y.Doc;
  /** repository full name, "owner/name" */
  repo: string;
  /** repo-relative path of the document */
  docPath: string;
  /** a sync round-trip failed mid-session — surfaced, session keeps running */
  onSyncError(message: string): void;
  /** the FIRST import failed — the shell falls back to the text view */
  onImportFailed(message: string): void;
  /** element badge clicked (todo anchors) */
  onBadgeClick(elementId: string): void;
  /** canvas selection changed — feeds todo creation and the assist handoff */
  onSelectionChanged(elements: TodoElementWire[]): void;
  /** open another model of the same repository inside designIQ (a link in a
   *  document); `fragment` is a section of it ("" = the top). Optional: an
   *  editor mounted without the shell leaves the navigation to its hrefs */
  onOpenModel?(path: string, fragment: string): void;
  /** the repository's models, for links between them (a document view).
   *  Optional: without it a link to a file with a notation extension counts
   *  as one to a model */
  models?: ModelDirectory;
  /** whether the editor's layer is on screen (the shell's view switch shows
   *  it, the Monaco source, or both side by side): a read-only view skips
   *  its renders while hidden and catches up when it shows. Optional:
   *  absent = always shown */
  visibility?: LayerVisibility;
  /** live presence (#115) — publish the local cursor/selection, subscribe to
   *  remote peers; the additive awareness surface promised on #124. Engines
   *  hand it to attachPresenceCanvas; optional keeps them mountable without
   *  a live session (tests, previews). */
  presence?: PresenceSurface;
  /** the shell's ⋯ menu trigger, where an engine's dialogs give the focus
   *  back when they close (MountedEditor.menu); null while not rendered */
  menuTrigger?(): HTMLElement | null;
  /** an action of the engine's menu failed (an export): surface it */
  onActionFailed?(message: string): void;
}

/** the model list as the shell has it: it may arrive after the editor
 *  mounts, and changes when a model is created, renamed or deleted */
export interface ModelDirectory {
  /** the repo-relative paths of the repository's models; undefined while the list loads */
  paths(): ReadonlySet<string> | undefined;
  /** subscribe to list changes; returns the unsubscribe */
  onChange(cb: () => void): () => void;
}

/** the editor layer's visibility as the shell has it */
export interface LayerVisibility {
  visible(): boolean;
  /** subscribe to visibility changes; returns the unsubscribe */
  onChange(cb: () => void): () => void;
}

/** a toolbar action the mounted editor contributes to the SHELL header
 *  (e.g. the t.BPM workshop toggle) — imperative twin of PanelSpec: the
 *  engine owns state and behavior, React only renders the button */
export interface EditorToolbarAction {
  id: string;
  /** button label, e.g. "Workshop" */
  label: string;
  buttonTitle: string;
  /** current on/off state (toggle actions); absent = stateless action */
  isActive?(): boolean;
  /** subscribe to state changes; returns the unsubscribe */
  onChanged?(cb: () => void): () => void;
  run(): void;
}

export interface MountedEditor {
  /** element surface (reveal / badges / one-shot deep-link reveal) — the
   *  todo-canvas contract; absent = the notation has no element identity */
  elements?: TodoCanvas;
  /** header actions this editor contributes (rendered by the shell) */
  actions?: EditorToolbarAction[];
  /** the renderer's own Model, Export and Help entries, which the shell's ⋯
   *  menu lists (a Miragon renderer that ships menu content) */
  menu?: ModelerMenu;
  destroy(): void;
}

/** a side panel the notation contributes (the DecisionChecksPanel pattern,
 *  made declarative) — fed the debounced live text while open */
export interface NotationPanelProps {
  repo: string;
  docPath: string;
  /** the live document text, debounced (~300ms) while the panel is open */
  content: string;
  /** select + scroll a canvas element into view; false when the id is not in
   *  the diagram (absent when no visual editor with element identity is up) */
  onRevealElement?(elementId: string): boolean;
  onClose(): void;
}
export interface PanelSpec {
  /** unique within the shell's panel namespace — "history" and "todos" are
   *  RESERVED by the shell (enforced below at registration time) */
  id: string;
  /** toolbar button label */
  label: string;
  buttonTitle: string;
  icon: ComponentType<{ className?: string }>;
  /** where the toggle lives: its own toolbar button (default) or an entry in
   *  the toolbar's overflow menu — for panels a session needs occasionally,
   *  not constantly (the Notes panel pattern) */
  placement?: "toolbar" | "menu";
  /** lazy panel body — only whoever opens the panel pays for its deps */
  component: LazyExoticComponent<ComponentType<NotationPanelProps>>;
}

/** the visual history diff (Compare) — absent = Monaco text diff only */
export interface DiagramDiffProps {
  /** file content at the commit (left, read-only) */
  historical: string;
  /** live document snapshot (right, read-only) */
  current: string;
  /** one side failed to import — the dialog falls back to the text diff */
  onUnavailable(): void;
}
export interface DiffSpec {
  component: LazyExoticComponent<ComponentType<DiagramDiffProps>>;
  legend: ReadonlyArray<{ label: string; color: string }>;
}

/** what the shell hands the tooling it attaches to its Monaco source */
export interface SourceContext {
  /** the Monaco API the editor runs on (Range, Selection, …): handed in, so
   *  the tooling's chunk never imports the editor itself */
  monaco: typeof Monaco;
}

/** an entry of a SourceMenu */
export interface SourceMenuItem {
  id: string;
  label: string;
  /** a line under the label: what the entry does */
  description?: string;
}

/** a menu the source tooling contributes to the SHELL header (Markdown:
 *  Insert diagram), shown while the source is on screen: React renders the
 *  trigger and the entries, the tooling runs them. An entry edits the
 *  source and gives the editor the focus back */
export interface SourceMenu {
  id: string;
  /** the trigger's label, e.g. "Insert diagram" */
  label: string;
  buttonTitle: string;
  icon: ComponentType<{ className?: string }>;
  /** a line over the entries; absent = none */
  heading?: string;
  items: readonly SourceMenuItem[];
  run(itemId: string): void;
}

/** the tooling attached to the shell's Monaco source */
export interface AttachedSource {
  /** header menus it contributes (rendered by the shell) */
  menus?: SourceMenu[];
  /** take back everything it added to the editor (actions, listeners) */
  dispose(): void;
}

/** how the shell's view switch names the canvas layer */
export interface CanvasViewLabel {
  /** the switch's label, e.g. "Preview" */
  label: string;
  buttonTitle: string;
  icon: ComponentType<{ className?: string }>;
}

export interface WebNotationPlugin {
  /** must match a NotationDescriptor.id (@designiq/notations) */
  id: string;
  /** css class of the canvas host (engine styling) */
  canvasClassName: string;
  /** the canvas layer's name in the view switch (absent = "Diagram") */
  canvasView?: CanvasViewLabel;
  /** the view switch gets a third view, Split: the Monaco source on the
   *  left, the canvas layer on the right, a divider between them, for a
   *  canvas that follows the text as it is typed (the Markdown view). The
   *  shell remembers the view per notation (lib/editor-view), and holds the
   *  keys typed in the source from a `documentKeys` engine. The engine must
   *  follow its host's size: the divider and the view switch resize the
   *  mounted canvas layer. No diagram-js engine of the SPA does yet (it
   *  takes a ResizeObserver calling canvas.resized(); without it the view
   *  restored after the next import is a stale viewbox and rescales the
   *  canvas), so the Miragon renderers wait for that. Absent =
   *  the canvas or the source, one at a time; BPMN and DMN never opt in
   *  (their panels dock over the canvas edge) */
  splitView?: boolean;
  /** mount the visual editor — the engine chunk loads HERE, not before;
   *  absent = collaborative Monaco (a plugin may contribute only panels/diff) */
  mountEditor?(container: HTMLElement, ctx: EditorContext): Promise<MountedEditor>;
  /** tooling for the shell's Monaco source: editor actions, header menus
   *  (SourceMenu). Attached once the editor exists and the session is live,
   *  disposed with the session; its chunk loads HERE, as an engine's does in
   *  mountEditor, so the manifest stays light. Works for a plugin with or
   *  without a visual editor. Absent = the plain editor */
  attachSource?(editor: Monaco.editor.IStandaloneCodeEditor, ctx: SourceContext): Promise<AttachedSource>;
  /** the engine takes its shortcuts from a keydown listener on document,
   *  wherever the focus is: the shell holds the keys from it while the canvas
   *  is behind the source layer or a dialog, and in the split view those
   *  typed in the source (lib/canvas-keys). Absent = the engine binds its
   *  keys to its own canvas (bpmn-js, dmn-js) */
  documentKeys?: boolean;
  panels?: PanelSpec[];
  /** notation id of the Analyse-with-AI handoff — absent = no assist menu */
  assistNotation?: string;
  diff?: DiffSpec;
}

// bpmn and dmn are bespoke plugins (stickies, todos, the differ; the Checks
// panel), markdown a read-only preview; every Miragon renderer derives its
// plugin from its spec
const WEB_PLUGINS: Record<string, WebNotationPlugin> = {
  bpmn: bpmnPlugin,
  dmn: dmnPlugin,
  markdown: markdownPlugin,
  ...Object.fromEntries(MIRAGON_RENDERERS.map((spec) => [spec.id, miragonPlugin(spec)])),
};

// the shell renders its own panels on these ids — a plugin colliding with them
// would open two panels behind one toolbar button. Fail LOUDLY at module load
// (a registration mistake must never ship as a subtle double-panel).
const RESERVED_PANEL_IDS = new Set(["history", "todos"]);
for (const plugin of Object.values(WEB_PLUGINS)) {
  for (const panel of plugin.panels ?? []) {
    if (RESERVED_PANEL_IDS.has(panel.id)) {
      throw new Error(`notation plugin '${plugin.id}' uses the reserved panel id '${panel.id}'`);
    }
  }
}

/** the plugin of a notation id — undefined = collaborative Monaco fallback */
export function webPlugin(notationId: string | undefined): WebNotationPlugin | undefined {
  return notationId ? WEB_PLUGINS[notationId] : undefined;
}
