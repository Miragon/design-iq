/**
 * The collaborative editor shell — the EDITOR a notation gets comes from the
 * web plugin registry (@/notations/registry, epic #118 step 6):
 *
 *   plugin       → its visual editor (bpmn-js / dmn-js / …) or read-only
 *                  view (the Markdown preview) mounted on the shared Y.Text,
 *                  plus its side panels, assist handoff and history diff —
 *                  the ENGINE chunks load lazily on mount; a plugin with the
 *                  split view shows its canvas beside the Monaco source too,
 *                  and its source tooling (Markdown: Insert diagram) attaches
 *                  to that Monaco, its chunk loading once the session is live
 *   no plugin    → Monaco text editor on the shared Y.Text, language from the
 *                  registry (Value Chains and YAML live-edit as text)
 *
 * React owns the shell (toolbar, presence, release); the editor ENGINES stay
 * imperative — the mounted plugin / Monaco / Yjs live in refs inside one effect
 * whose cleanup tears the whole live session down (provider, sockets, bindings).
 */
import { type MovedNotice, type PresenceUser, roomName } from "@designiq/contracts/live";
import { openLiveSession } from "@designiq/live-client";
import { updateText } from "@designiq/live-client/text";
import { byExtension, type MediaKind, modelStem } from "@designiq/notations";
import { cn } from "@designiq/ui-kit/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { History, ListTodo } from "lucide-react";
import * as monaco from "monaco-editor";
import { type CSSProperties, Suspense, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { MonacoBinding } from "y-monaco";
import type * as Y from "yjs";

import { AssistMenu } from "@/components/assist-menu";
import { DuplicateModelDialog } from "@/components/duplicate-model-dialog";
import { EditorToolbar, type ToolbarPanelItem } from "@/components/editor-toolbar";
import { HistoryDiffDialog } from "@/components/history-diff-dialog";
import { HistoryPanel } from "@/components/history-panel";
import { ReleaseDialog } from "@/components/release-dialog";
import { RenameModelDialog } from "@/components/rename-model-dialog";
import { SPLIT_PANES, SplitDivider, useSplitRoom } from "@/components/split-divider";
import { TodoCreateDialog } from "@/components/todo-create-dialog";
import { TodoPanel } from "@/components/todo-panel";
import {
  config,
  fetchFileAtCommit,
  type FileCommitWire,
  type Me,
  presenceColor,
  type TodoElementWire,
  type TodoWire,
} from "@/lib/api";
import { keepKeysFromCanvas } from "@/lib/canvas-keys";
import {
  editorLayers,
  type EditorView,
  editorViews,
  heldCanvasKeys,
  readViewChoice,
  rememberViewChoice,
  type ViewChoice,
} from "@/lib/editor-view";
import { modelTarget, useOpenModel, wasExpected } from "@/lib/model-target";
import { installMonacoLanguages } from "@/lib/monaco-languages";
import { installMonacoTheme, MONACO_OPTIONS } from "@/lib/monaco-theme";
import type { PresenceSurface, RemotePresence } from "@/lib/presence-canvas";
import { invalidateModelLists, useFileHistory, useModels, useTodos } from "@/lib/queries";
import { createRemoteCaretStyles } from "@/lib/remote-carets";
import { clampRatio, DEFAULT_RATIO, ratioBounds } from "@/lib/split-ratio";
import type { TodoCanvas } from "@/lib/todo-canvas";
import {
  type AttachedSource,
  type EditorToolbarAction,
  type MountedEditor,
  type SourceMenu,
  webPlugin,
} from "@/notations/registry";

/** the view switch's name for the source layer, by the notation's media kind */
const SOURCE_LABEL: Record<MediaKind, string> = { xml: "XML", json: "JSON", dsl: "Text", markdown: "Markdown" };

function monacoLanguage(docPath: string): string {
  const notation = byExtension(docPath);
  if (notation) return notation.monacoLanguage;
  if (docPath.endsWith(".yaml") || docPath.endsWith(".yml")) return "yaml";
  return "plaintext";
}

export function LiveEditor({
  repo,
  processId,
  docPath,
  backDir,
  revealElementId,
  me,
}: {
  repo: string;
  processId: string;
  docPath: string;
  /** processes-root-relative folder the Back arrow returns to ("" = root) */
  backDir?: string;
  /** deep-link target (?element=<id>) — revealed ONCE after the first diagram import */
  revealElementId?: string;
  me: Me;
}) {
  const notation = byExtension(docPath);
  const plugin = webPlugin(notation?.id);
  const isVisual = plugin?.mountEditor !== undefined;
  // a STRUCTURED room's truth lives in the element maps, NOT in CONTENT_KEY —
  // a writable Monaco bound there would sync typed text to peers but never
  // reach disk/REST/history (silent loss). No text tab until the structured
  // text lane is properly wired (dark today: every shipped notation is text).
  const structuredDoc = notation?.docShape === "structured";
  // cosmetic special case: bpmn is the platform's primary notation — its label
  // badge stays hidden and the title shows the process id alone
  const isBpmn = notation?.id === "bpmn";
  const fileName = docPath.split("/").pop() ?? docPath;
  const sourceLabel = notation ? SOURCE_LABEL[notation.mediaKind] : "Text";
  // the view switch's third view: the source beside the canvas layer
  const splitView = isVisual && !structuredDoc && plugin?.splitView === true;

  const canvasRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const sourcePaneId = useId();
  const [status, setStatus] = useState<"connecting" | "slow" | "live" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  // the view a person chose (lib/editor-view): a notation with the split view
  // opens the way its last document was left, the others on their canvas.
  // The shell's own fallbacks set it too, but only a choice is remembered.
  const [remembered] = useState<ViewChoice>(() => (splitView && notation ? readViewChoice(notation.id) : {}));
  const [view, setView] = useState<EditorView>(isVisual ? (remembered.view ?? "canvas") : "source");
  const views = editorViews(setView, splitView ? notation?.id : undefined);
  /** the divider's position: the source pane's share of the width */
  const [ratio, setRatio] = useState(remembered.ratio ?? DEFAULT_RATIO);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  /** the mounted editor exposed an element surface (selection, reveal) */
  const [hasElements, setHasElements] = useState(false);
  /** header actions the mounted editor contributes (e.g. the t.BPM toggle) */
  const [editorActions, setEditorActions] = useState<EditorToolbarAction[]>([]);
  /** header menus the source tooling contributes (Markdown: Insert diagram) */
  const [sourceMenus, setSourceMenus] = useState<SourceMenu[]>([]);
  /** where a rename moved this document (#208) — set by the session's notice */
  const [movedTo, setMovedTo] = useState<MovedNotice | null>(null);

  // model-anchored todos — only for documents that belong to a process
  const hasTodos = processId.length > 0;
  const todosQuery = useTodos(repo, processId, hasTodos);
  const [selectedElements, setSelectedElements] = useState<TodoElementWire[]>([]);
  const [todoFilter, setTodoFilter] = useState<string | null>(null);
  const [todoCreateOpen, setTodoCreateOpen] = useState(false);
  // the canvas controller lives inside the imperative session effect; the query
  // data flows in through these refs (and the effect below) in either order
  const todoCanvasRef = useRef<TodoCanvas | null>(null);
  const todosRef = useRef<TodoWire[]>([]);

  // plugin side panels — fed the debounced live text while open
  const [panelContent, setPanelContent] = useState("");

  // a link to another model of this repository (the Markdown view): the
  // session effect mounts once, the handler behind this ref follows the
  // current model list and router (assigned below, once both exist)
  const openLinkedModelRef = useRef<(path: string, fragment: string) => void>(() => undefined);
  // the repository's model paths for the mounted editor (links between
  // models): the list arrives after the mount and changes with the repository
  const modelPathsRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const modelListenersRef = useRef(new Set<() => void>());
  // whether the canvas layer is on screen, for the mounted editor: a
  // read-only view (the Markdown view and its diagrams) skips its renders
  // while only the source layer shows (not in the split view)
  const canvasShownRef = useRef(true);
  const canvasShownListenersRef = useRef(new Set<() => void>());

  // the ONE open side panel — the panels are mutually exclusive, and the rule
  // lives here instead of being hand-written into every toggle (one of the
  // five copies had already gone stale). Plugin panels join by their id.
  const [panel, setPanel] = useState<string | null>(null);
  const togglePanel = (name: string): void => {
    setTodoFilter(null);
    setPanel((current) => (current === name ? null : name));
  };
  const closePanel = (): void => {
    setTodoFilter(null);
    setPanel(null);
  };
  const activePanelSpec = plugin?.panels?.find((p) => p.id === panel);
  // default-branch commit history of THIS file — fetched while the panel is open
  const historyQuery = useFileHistory(repo, docPath, panel === "history");
  // the shared Y.Text, exposed from the session effect for Compare/Restore
  const contentRef = useRef<Y.Text | null>(null);
  const [diff, setDiff] = useState<{ commit: FileCommitWire; historical: string; current: string } | null>(null);

  const todoList = todosQuery.data;
  useEffect(() => {
    todosRef.current = todoList ?? [];
    todoCanvasRef.current?.setTodos(todosRef.current);
  }, [todoList]);

  // deep-link reveal: hand the ?element target to the canvas controller. Before
  // the controller exists (session still syncing) it is parked in the ref and
  // armed once in attach(); the controller's revealOnce consumes it after the
  // FIRST import.done, so remote re-imports / session re-attaches never re-zoom.
  const pendingRevealRef = useRef<string | null>(null);
  useEffect(() => {
    if (!revealElementId) return;
    const canvas = todoCanvasRef.current;
    if (canvas) canvas.revealOnce(revealElementId);
    else pendingRevealRef.current = revealElementId;
  }, [revealElementId]);

  useEffect(() => {
    let cancelled = false;
    const session = openLiveSession({
      url: config.wsUrl,
      // room name = <repo-full-name>/<repo-relative-path> (@designiq/contracts/live)
      room: roomName(repo, docPath),
      token: me.wsToken,
      onAuthenticationFailed: (reason) => {
        if (cancelled) return;
        setError(`Access denied: ${reason}`);
        setStatus("error");
      },
    });
    session.setUser({
      name: me.user.name || me.user.login,
      color: presenceColor(me.user.login),
      avatarUrl: me.user.avatarUrl,
    });
    // the model was renamed (#208): the Live Host closes this room right
    // after the notice — the screen follows the document to its new path
    let moved = false;
    const offMoved = session.onMoved((notice) => {
      if (cancelled) return;
      moved = true;
      setMovedTo(notice);
    });
    // a doc-level CLOSE (e.g. an oversized update rejected server-side) kills
    // the document WITHOUT a ws reconnect — surfaced, or the session would
    // just silently stop syncing while looking live
    const offDocClose = session.onDocClose(() => {
      if (cancelled || moved) return;
      setStatus("error");
      setError("The server closed this live document — reload the page to reconnect.");
    });

    // Presence fan-out (#115): ONE awareness subscription feeds the Monaco
    // remote-caret styles AND whatever canvas controller the mounted engine
    // attaches through ctx.presence. Peers without a user field haven't
    // announced themselves yet — nothing to render for them.
    const caretStyles = createRemoteCaretStyles();
    const remoteListeners = new Set<(peers: RemotePresence[]) => void>();
    let lastRemote: RemotePresence[] = [];
    const presenceSurface: PresenceSurface = {
      setLocal: (p) => session.setCanvasPresence(p),
      onRemote: (cb) => {
        remoteListeners.add(cb);
        cb(lastRemote);
        return () => remoteListeners.delete(cb);
      },
    };
    const offAwareness = session.onAwarenessStates((peers) => {
      lastRemote = peers.filter((p): p is RemotePresence => p.user !== undefined);
      caretStyles.update(lastRemote);
      for (const cb of remoteListeners) cb(lastRemote);
    });

    let mounted: MountedEditor | undefined;
    let monacoBinding: MonacoBinding | undefined;
    let sourceEditor: monaco.editor.IStandaloneCodeEditor | undefined;
    let sourceModel: monaco.editor.ITextModel | undefined;
    let sourceTools: AttachedSource | undefined;
    let offPresence: (() => void) | undefined;
    let attached = false;

    // Attach the editor ENGINES when the doc syncs — even if that takes longer
    // than the "slow" hint below (a Fly cell resuming from suspend + first clone
    // can exceed 10s). No hard timeout that abandons a late sync into a dead editor.
    const attach = async () => {
      if (cancelled || attached) return;
      attached = true;
      const ytext = session.content;
      contentRef.current = ytext;
      if (plugin?.mountEditor && canvasRef.current) {
        // the engine chunk loads HERE — the eager bundle carries no editor
        // engine. A failed chunk load (offline, stale deploy rotating hashed
        // asset URLs) must NOT strand the session: fall back to the text view
        // below — the ytext is already synced, editing works without the engine.
        let editor: MountedEditor | undefined;
        try {
          editor = await plugin.mountEditor(canvasRef.current, {
            ytext,
            doc: session.doc,
            repo,
            docPath,
            onSyncError: (msg) => {
              if (!cancelled) toast.error(msg);
            },
            onImportFailed: (msg) => {
              if (cancelled) return; // an in-flight first import can settle after unmount
              toast.error(`${notation?.label ?? "Model"} import failed: ${msg}`);
              views.fallBack(); // not a choice: never remembered
            },
            onBadgeClick: (elementId) => {
              setTodoFilter(elementId);
              setPanel("todos");
            },
            onSelectionChanged: setSelectedElements,
            onOpenModel: (path, fragment) => openLinkedModelRef.current(path, fragment),
            models: {
              paths: () => modelPathsRef.current,
              onChange: (cb) => {
                modelListenersRef.current.add(cb);
                return () => modelListenersRef.current.delete(cb);
              },
            },
            visibility: {
              visible: () => canvasShownRef.current,
              onChange: (cb) => {
                canvasShownListenersRef.current.add(cb);
                return () => canvasShownListenersRef.current.delete(cb);
              },
            },
            presence: presenceSurface,
          });
        } catch (e) {
          if (!cancelled) {
            toast.error(
              `${notation?.label ?? "Model"} editor failed to load (${e instanceof Error ? e.message : String(e)}) — falling back to the text view.`,
            );
            views.fallBack(); // not a choice: never remembered
          }
        }
        if (cancelled) {
          // unmounted while the chunk loaded — tear the late editor down
          editor?.destroy();
          return;
        }
        mounted = editor;
        setEditorActions(editor?.actions ?? []);
        if (editor?.elements) {
          setHasElements(true);
          todoCanvasRef.current = editor.elements;
          editor.elements.setTodos(todosRef.current);
          if (pendingRevealRef.current) {
            // deep link opened before the session synced — arm the one-shot now
            editor.elements.revealOnce(pendingRevealRef.current);
            pendingRevealRef.current = null;
          }
        }
      }
      if (cancelled) return;
      if (sourceRef.current && !structuredDoc) {
        // before the model: a Markdown source tokenizes its fences in the languages it names
        installMonacoLanguages(monaco.languages);
        sourceModel = monaco.editor.createModel(ytext.toString(), monacoLanguage(docPath));
        installMonacoTheme(monaco.editor);
        sourceEditor = monaco.editor.create(sourceRef.current, {
          ...MONACO_OPTIONS,
          model: sourceModel,
          automaticLayout: true,
          minimap: { enabled: false },
          // prose: a paragraph is one line, and half the width (the split
          // view) must not scroll it sideways
          wordWrap: sourceModel.getLanguageId() === "markdown" ? "on" : "off",
        });
        monacoBinding = new MonacoBinding(ytext, sourceModel, new Set([sourceEditor]), session.awareness ?? undefined);
      }
      offPresence = session.onPresence(setPresence);
      setStatus("live");
      // the plugin's source tooling: its chunk loads HERE, once the session
      // is live (a slow chunk never holds the editor back). A failed load
      // costs the tools, not the editor, which works without them
      if (plugin?.attachSource && sourceEditor) {
        let tools: AttachedSource | undefined;
        try {
          tools = await plugin.attachSource(sourceEditor, { monaco });
        } catch (e) {
          if (!cancelled) {
            toast.error(
              `The ${notation?.label ?? "source"} tools failed to load (${e instanceof Error ? e.message : String(e)}). Editing works without them.`,
            );
          }
        }
        if (cancelled) {
          // unmounted while the chunk loaded: take the late tools back off
          tools?.dispose();
          return;
        }
        sourceTools = tools;
        setSourceMenus(tools?.menus ?? []);
      }
    };
    const offSynced = session.onSynced(() => {
      if (cancelled) return;
      if (!attached) return void attach();
      // a RE-sync means the doc provably came back (transient ws drop, or a
      // server restart after a doc close) — an error banner must not outlive
      // a live session
      setStatus("live");
      setError(null);
    });
    // still connecting after 10s → tell the user it's taking a while, keep waiting
    const slow = setTimeout(() => {
      if (!cancelled && !attached) setStatus("slow");
    }, 10_000);

    return () => {
      cancelled = true;
      clearTimeout(slow);
      offSynced();
      offPresence?.();
      offAwareness();
      offMoved();
      offDocClose();
      caretStyles.destroy();
      contentRef.current = null;
      todoCanvasRef.current = null;
      setEditorActions([]);
      setSourceMenus([]);
      mounted?.destroy();
      sourceTools?.dispose();
      monacoBinding?.destroy();
      sourceEditor?.dispose();
      sourceModel?.dispose();
      session.destroy(); // provider AND socket
    };
  }, [repo, docPath, me.wsToken]);

  // Feed the open plugin panel from the shared Y.Text — only while it is OPEN,
  // and debounced: re-analysing on every keystroke of a co-editor would be pure
  // waste (`status` re-runs this once the session attached contentRef).
  useEffect(() => {
    const ytext = activePanelSpec ? contentRef.current : null;
    if (!ytext) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => setPanelContent(ytext.toString());
    sync();
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(sync, 300);
    };
    ytext.observe(onChange);
    return () => {
      clearTimeout(timer);
      ytext.unobserve(onChange);
    };
  }, [activePanelSpec, status]);

  // release = pick files in the ReleaseDialog, THIS document preselected
  const [releaseOpen, setReleaseOpen] = useState(false);

  // rename / duplicate THIS model (#208, #209) — the dialogs are shared with
  // the overview; the editor knows the model is open (liveSessions ≥ 1)
  const [renameOpen, setRenameOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const self = modelTarget(docPath, { folder: backDir ?? "", liveSessions: 1, dirty: false });
  const models = useModels(repo);
  const takenIds = new Set((models.data ?? []).filter((m) => m.notation === self.notation).map((m) => m.id));
  const openModel = useOpenModel(repo);
  const qc = useQueryClient();
  const knownModels = models.data;
  // the mounted editor's model paths follow the list
  useEffect(() => {
    modelPathsRef.current = knownModels ? new Set(knownModels.map((m) => m.path)) : undefined;
    for (const cb of modelListenersRef.current) cb();
  }, [knownModels]);
  // a linked model opens on its own route (#section included); a link to a
  // path the repository has no model at says so, instead of opening an
  // editor whose room never syncs. Once the list has loaded the view renders
  // such a link as text: this check covers a click before that.
  useEffect(() => {
    openLinkedModelRef.current = (path, fragment) => {
      if (knownModels && !knownModels.some((m) => m.path === path)) {
        toast(`There is no model at ${path}`, {
          description: "The link points at a file that is not a model of this repository.",
        });
        return;
      }
      void openModel(path, fragment ? { hash: fragment } : {});
    };
  }, [knownModels, openModel]);
  // the document moved (a rename — ours or a colleague's): follow it. The
  // notice arrives exactly once per session; the ref keeps StrictMode's
  // double-run from navigating (and announcing) twice
  const followed = useRef<MovedNotice | null>(null);
  useEffect(() => {
    if (!movedTo || followed.current === movedTo) return;
    followed.current = movedTo;
    invalidateModelLists(qc, repo);
    // our own rename already announced itself (useRenameModel's toast)
    if (!wasExpected(movedTo.to)) {
      toast(`${movedTo.by || "Someone"} renamed this model to '${modelStem(movedTo.to)}'`, {
        description: "You continue editing it under the new name.",
      });
    }
    void openModel(movedTo.to, { replace: true });
  }, [movedTo, openModel, qc, repo]);

  // TanStack v5 runs hook-level onSuccess/onError even after unmount and for
  // superseded mutate() calls — guard both: only the LATEST action may apply,
  // and nothing toasts onto an unrelated screen after this editor is gone
  const actionSeqRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const fetchCommitContent = async (commit: FileCommitWire) => {
    const seq = ++actionSeqRef.current;
    const file = await fetchFileAtCommit(repo, docPath, commit.sha);
    return { commit, historical: file.content, seq };
  };
  const onActionError = (e: Error) => {
    if (aliveRef.current) toast.error(e.message);
  };

  // Compare: fetch the commit's content, snapshot the live doc, open the diff
  const compare = useMutation({
    mutationFn: fetchCommitContent,
    onSuccess: ({ commit, historical, seq }) => {
      if (seq !== actionSeqRef.current || !aliveRef.current) return; // superseded or editor gone
      const current = contentRef.current?.toString();
      if (current === undefined) return; // session not attached — nothing to diff against
      setDiff({ commit, historical, current });
    },
    onError: onActionError,
  });

  // Restore: write the commit's content into the shared Y.Text — updateText's
  // minimal diff syncs to every client, the canvas binding re-imports the view
  const restore = useMutation({
    mutationFn: fetchCommitContent,
    onSuccess: ({ commit, historical, seq }) => {
      if (seq !== actionSeqRef.current || !aliveRef.current) return; // superseded or editor gone
      const ytext = contentRef.current;
      if (!ytext) {
        return void toast.error("Restore cancelled — the live session ended before the commit content arrived.");
      }
      updateText(ytext, historical);
      setDiff(null);
      toast.success(`Restored ${fileName} to ${commit.sha.slice(0, 7)}`, { description: commit.subject });
    },
    onError: onActionError,
  });
  const historyActionSha = compare.isPending
    ? (compare.variables?.sha ?? null)
    : restore.isPending
      ? (restore.variables?.sha ?? null)
      : null;

  // Split needs room (lib/editor-view): without it the canvas shows, and the
  // choice stays for when the window is wide again
  const room = useSplitRoom(layersRef, splitView);
  const splitAvailable = splitView && room.fits;
  const layers = editorLayers(view, { visual: isVisual, structured: structuredDoc, splitAvailable });
  const { shown, split, sourceShown, canvasShown } = layers;
  const bounds = ratioBounds(room.width, room.rem);
  const shownRatio = clampRatio(ratio, bounds);
  const ActivePanel = activePanelSpec?.component;
  // the mounted editor follows the view switch (see canvasShownRef)
  useEffect(() => {
    canvasShownRef.current = canvasShown;
    for (const cb of canvasShownListenersRef.current) cb();
  }, [canvasShown]);
  // the canvas engine stays mounted behind the source layer and the dialogs:
  // one that takes its shortcuts from document hears keys only while in front
  // (lib/canvas-keys), and in the split view not those typed in the source
  // beside it (Monaco and its widgets live inside the source layer)
  const dialogOpen = diff !== null || todoCreateOpen || releaseOpen || renameOpen || duplicateOpen;
  const keysHeld = heldCanvasKeys(layers, { documentKeys: plugin?.documentKeys === true, dialogOpen });
  useEffect(() => {
    if (keysHeld === "none") return undefined;
    return keepKeysFromCanvas(document, keysHeld === "source" ? (sourceRef.current ?? undefined) : undefined);
  }, [keysHeld]);

  // the notation plugin's panels and the shell's own (todos, history) are the
  // same KIND of thing to the user, so they render the same way and carry the
  // same open/closed state — split only by PLACEMENT: everyday toggles keep
  // their bar button, occasional ones (Notes, History) live in the ⋯ menu
  const pluginPanels = (plugin?.panels ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    title: p.buttonTitle,
    icon: p.icon,
    placement: p.placement,
  }));
  const toolbarPanels: ToolbarPanelItem[] = [
    ...pluginPanels.filter((p) => p.placement !== "menu"),
    ...(hasTodos
      ? [
          {
            id: "todos",
            label: "Todos",
            title: "Open todos for this process",
            icon: ListTodo,
            count: todoList?.length,
          },
        ]
      : []),
  ];
  const menuPanels: ToolbarPanelItem[] = [
    ...pluginPanels.filter((p) => p.placement === "menu"),
    { id: "history", label: "History", title: "History of this file on the default branch", icon: History },
  ];

  return (
    <div className="flex h-full flex-col">
      <EditorToolbar
        repo={repo}
        title={processId || fileName}
        subtitle={!isBpmn && processId ? fileName : undefined}
        backDir={backDir}
        notationLabel={notation && !isBpmn ? notation.label : undefined}
        status={status}
        presence={presence}
        modeActions={editorActions}
        sourceMenus={sourceShown ? sourceMenus : []}
        view={
          isVisual && !structuredDoc
            ? {
                canvas: plugin?.canvasView,
                sourceLabel,
                shown,
                split: splitAvailable,
                onChange: views.choose,
              }
            : undefined
        }
        panels={toolbarPanels}
        menuPanels={menuPanels}
        activePanel={panel}
        onTogglePanel={togglePanel}
        addTodo={
          hasTodos ? { selectionCount: selectedElements.length, onAdd: () => setTodoCreateOpen(true) } : undefined
        }
        assist={
          plugin?.assistNotation ? (
            <AssistMenu
              repo={repo}
              path={docPath}
              notation={plugin.assistNotation}
              selection={hasElements ? selectedElements : undefined}
            />
          ) : undefined
        }
        onRelease={() => setReleaseOpen(true)}
        onRename={() => setRenameOpen(true)}
        onDuplicate={() => setDuplicateOpen(true)}
      />
      {error && <div className="bg-destructive-soft text-destructive border-b px-4 py-2 text-sm">{error}</div>}
      <div
        ref={layersRef}
        className="relative min-h-0 flex-1"
        style={split ? ({ "--split": `${shownRatio * 100}%` } as CSSProperties) : undefined}
      >
        {/* both layers stay mounted and laid out (the engines measure their
            host), the hidden one inert: out of the Tab order — a Tab into an
            invisible Monaco would type indentation into the shared model.
            The split view only narrows the SAME two nodes: moved into another
            tree, React would make new ones, and the engines mounted once per
            session would stay on the old. The source comes first, so the Tab
            order follows the screen: source, divider, canvas */}
        <div
          ref={sourceRef}
          id={sourcePaneId}
          inert={!sourceShown}
          className={cn("monaco-host absolute inset-0", !sourceShown && "pointer-events-none opacity-0")}
          style={split ? SPLIT_PANES.source : undefined}
        />
        {split && (
          <SplitDivider
            ratio={shownRatio}
            bounds={bounds}
            labels={[sourceLabel, plugin?.canvasView?.label ?? "Diagram"]}
            controls={sourcePaneId}
            onChange={setRatio}
            onCommit={(next) => {
              if (notation) rememberViewChoice(notation.id, { ratio: next });
            }}
          />
        )}
        <div
          ref={canvasRef}
          inert={!canvasShown}
          className={cn(plugin?.canvasClassName, "absolute inset-0", !canvasShown && "pointer-events-none opacity-0")}
          style={split ? SPLIT_PANES.canvas : undefined}
        />
        {ActivePanel && (
          <Suspense fallback={null}>
            <ActivePanel
              repo={repo}
              docPath={docPath}
              content={panelContent}
              onRevealElement={
                hasElements
                  ? (elementId) => {
                      const found = todoCanvasRef.current?.reveal(elementId) ?? false;
                      // a reveal must be VISIBLE, not on the hidden canvas
                      if (found) views.reveal();
                      return found;
                    }
                  : undefined
              }
              onClose={closePanel}
            />
          </Suspense>
        )}
        {panel === "history" && (
          <HistoryPanel
            commits={historyQuery.data}
            isLoading={historyQuery.isLoading}
            error={historyQuery.error}
            pendingSha={historyActionSha}
            actionsEnabled={status === "live"}
            onCompare={(c) => compare.mutate(c)}
            onRestore={(c) => restore.mutate(c)}
            onClose={closePanel}
          />
        )}
        {hasTodos && panel === "todos" && (
          <TodoPanel
            repo={repo}
            processId={processId}
            todos={todoList}
            isLoading={todosQuery.isLoading}
            error={todosQuery.error}
            filterElementId={todoFilter}
            onClearFilter={() => setTodoFilter(null)}
            onRevealElement={(elementId) => {
              if (!todoCanvasRef.current?.reveal(elementId))
                toast(`Element '${elementId}' no longer exists in the diagram.`);
            }}
            onClose={closePanel}
          />
        )}
      </div>
      {hasTodos && todoCreateOpen && (
        <TodoCreateDialog
          repo={repo}
          processId={processId}
          docPath={docPath}
          elements={selectedElements}
          onClose={() => setTodoCreateOpen(false)}
        />
      )}
      {diff && (
        <HistoryDiffDialog
          commit={diff.commit}
          historical={diff.historical}
          current={diff.current}
          language={monacoLanguage(docPath)}
          diagramDiff={plugin?.diff}
          restorePending={restore.isPending}
          onRestore={() => restore.mutate(diff.commit)}
          onClose={() => setDiff(null)}
        />
      )}
      {releaseOpen && <ReleaseDialog repo={repo} preselect={[docPath]} onClose={() => setReleaseOpen(false)} />}
      {renameOpen && (
        <RenameModelDialog
          repo={repo}
          model={self}
          onClose={() => setRenameOpen(false)}
          // the moved notice usually gets here first — both lead to the same page
          onRenamed={(result) => void openModel(result.path, { replace: true })}
        />
      )}
      {duplicateOpen && (
        <DuplicateModelDialog
          repo={repo}
          model={self}
          takenIds={takenIds}
          onClose={() => setDuplicateOpen(false)}
          onDuplicated={({ model }) => {
            setDuplicateOpen(false);
            toast.success(`Duplicated as '${model.id}'`, {
              description: "You are editing the copy now.",
              action: { label: "Back to the original", onClick: () => void openModel(docPath) },
            });
            void openModel(model.path);
          }}
        />
      )}
    </div>
  );
}
