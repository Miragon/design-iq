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
 *                  registry (YAML files live-edit as text)
 *
 * A STRUCTURED document (a board) keeps its elements in the room's maps, not
 * in a text: its canvas edits it, its source is the codec's text of those
 * maps, read-only, and its history compares and restores through the codec
 * (lib/live-doc-text.ts). An editor that shows other files of the repository
 * in place (a board's models) opens them through ctx.linkedFiles, over one
 * more socket that ends after the editor let go of them (lib/linked-files.ts).
 *
 * React owns the shell (toolbar, presence, release); the editor ENGINES stay
 * imperative — the mounted plugin / Monaco / Yjs live in refs inside one effect
 * whose cleanup tears the whole live session down (provider, sockets, bindings).
 */
import { isUnreadableRefusal, type MovedNotice, type PresenceUser, roomName } from "@designiq/contracts/live";
import { openLiveSession, openLiveSessionGroup } from "@designiq/live-client";
import { byExtension, hasTodos as offersTodos, type MediaKind, modelStem } from "@designiq/notations";
import { docCodecFor } from "@designiq/notations/codecs";
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
  fetchModels,
  type FileCommitWire,
  type Me,
  type ModelInfo,
  presenceColor,
  type TodoElementWire,
  type TodoModelRef,
  type TodoWire,
} from "@/lib/api";
import { type FocusableCanvas, focusCanvasIn, viewSwitchFocus } from "@/lib/canvas-focus";
import {
  editorLayers,
  type EditorView,
  editorViews,
  HIDDEN_LAYER_CLASS,
  readViewChoice,
  rememberViewChoice,
  type ViewChoice,
} from "@/lib/editor-view";
import { linkedFiles } from "@/lib/linked-files";
import { type LiveDocText, liveDocText, textEdits } from "@/lib/live-doc-text";
import { modelTarget, useOpenModel, wasExpected } from "@/lib/model-target";
import { installMonacoLanguages } from "@/lib/monaco-languages";
import { installMonacoTheme, MONACO_OPTIONS } from "@/lib/monaco-theme";
import type { PresenceSurface, RemotePresence } from "@/lib/presence-canvas";
import {
  invalidateModelLists,
  useConfig,
  useDefaultBranch,
  useFileHistory,
  useModels,
  useTodos,
  useTodoTypes,
} from "@/lib/queries";
import { createRemoteCaretStyles } from "@/lib/remote-carets";
import { layoutBesideSidePanels, sidePanelRoom } from "@/lib/side-panel-room";
import { clampRatio, DEFAULT_RATIO, ratioBounds } from "@/lib/split-ratio";
import type { TodoCanvas } from "@/lib/todo-canvas";
import type { ModelerMenu } from "@/mcp-app/core/menu-model";
import {
  type AttachedSource,
  type EditorToolbarAction,
  type MountedEditor,
  type RepoWeb,
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

/** how long a structured document's source waits for its canvas to rest before it shows the change */
const SOURCE_REST_MS = 300;

const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `model` brought to `text` by its changed parts alone (lib/live-doc-text
 *  textEdits): whoever reads a read-only source keeps their place while a
 *  co-editor moves an element */
function showText(model: monaco.editor.ITextModel, text: string): void {
  const edits = textEdits(model.getValue(), text);
  if (edits.length === 0) return;
  model.applyEdits(
    edits.map(({ start, end, text: insert }) => ({
      range: monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)),
      text: insert,
    })),
  );
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
  // a STRUCTURED room's truth lives in the element maps, NOT in CONTENT_KEY:
  // a writable Monaco bound there would sync typed text to peers but never
  // reach disk/REST/history (silent loss). Its source is the codec's text of
  // the maps instead, read-only (only its canvas edits it), and never split.
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
  /** the mounted renderer's own menu entries, for the ⋯ menu */
  const [editorMenu, setEditorMenu] = useState<ModelerMenu | undefined>(undefined);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  /** header menus the source tooling contributes (Markdown: Insert diagram) */
  const [sourceMenus, setSourceMenus] = useState<SourceMenu[]>([]);
  /** where a rename moved this document (#208) — set by the session's notice */
  const [movedTo, setMovedTo] = useState<MovedNotice | null>(null);
  /** the canvas sync's notice that the shared text stays unrenderable (#296); null while it renders */
  const [unrenderable, setUnrenderable] = useState<string | null>(null);

  // model-anchored todos — on a model whose notation takes them: a process
  // once its id is known, any other model once the listing knows its file
  // (a file outside the models folder is no model, and gets none)
  const models = useModels(repo);
  const listed = models.data?.find((m) => m.path === docPath);
  const todoModel: TodoModelRef | undefined =
    !notation || !offersTodos(notation.id)
      ? undefined
      : isBpmn
        ? processId
          ? { notation: "bpmn", id: processId }
          : undefined
        : listed
          ? { notation: notation.id, id: listed.id }
          : undefined;
  const hasTodos = todoModel !== undefined;
  /** how the model is called in the todo copy ("process", "Wardley Map", "document", …) */
  const noun = notation?.noun.singular ?? "model";
  const todosQuery = useTodos(repo, todoModel, hasTodos);
  // the Add todo dialog opens with the repo's todo types already there
  useTodoTypes(repo, hasTodos);
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
  // the list they were made from: a list loaded anew that equals it (the
  // query shares what did not change) keeps their version
  const modelListRef = useRef<readonly ModelInfo[] | undefined>(undefined);
  const showModelsRef = useRef((list: readonly ModelInfo[] | undefined): void => {
    if (list === modelListRef.current) return;
    modelListRef.current = list;
    modelPathsRef.current = list ? new Set(list.map((m) => m.path)) : undefined;
    for (const cb of modelListenersRef.current) cb();
  });
  // ... and where the repository lives on GitHub (links to its models there),
  // once the host's configuration and the repository list have arrived
  const repoWebRef = useRef<RepoWeb | undefined>(undefined);
  const repoWebListenersRef = useRef(new Set<() => void>());
  // whether the canvas layer is on screen, for the mounted editor: a
  // read-only view (the Markdown view and its diagrams) skips its renders
  // while only the source layer shows (not in the split view)
  const canvasShownRef = useRef(true);
  const canvasShownListenersRef = useRef(new Set<() => void>());
  // the canvas a click on the chrome hands the focus back to (lib/canvas-focus)
  const mountedRef = useRef<MountedEditor | undefined>(undefined);
  const [canvasFocus] = useState<FocusableCanvas>(() => ({
    shown: () => canvasShownRef.current,
    focus: () => focusCanvasIn(canvasRef.current, mountedRef.current),
  }));
  const [viewFocus] = useState(() => viewSwitchFocus(canvasFocus));

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
  // the shared Y.Text, exposed from the session effect for the plugin panels
  const contentRef = useRef<Y.Text | null>(null);
  // the document as its file's text, by the room's shape, for Compare/Restore
  const docTextRef = useRef<LiveDocText | null>(null);
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
        // a board on disk its reader would not write back whole is refused as well: say why, not "denied"
        setError(isUnreadableRefusal(reason) ? reason : `Access denied: ${reason}`);
        setStatus("error");
      },
    });
    // the person, the same in this room and in every linked one they edit in
    const user: PresenceUser = {
      name: me.user.name || me.user.login,
      color: presenceColor(me.user.login),
      avatarUrl: me.user.avatarUrl,
    };
    session.setUser(user);
    // other files of this repository the mounted editor shows in place (a
    // board's models), live: one more socket for all of them, opened with the
    // first, and the person in a file's roster only while they edit it there
    const linked = linkedFiles({
      listed: () => modelPathsRef.current,
      room: (path) => roomName(repo, path),
      openGroup: () => openLiveSessionGroup({ url: config.wsUrl, token: me.wsToken }),
      user,
      // a model the board shows was renamed or moved: the list learns its new path
      onMoved: () => {
        if (!cancelled) void qc.invalidateQueries({ queryKey: ["models", repo] });
      },
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
    /** the editor's mount while its chunk loads: a teardown meanwhile waits for it */
    let mounting: Promise<MountedEditor> | undefined;
    let monacoBinding: MonacoBinding | undefined;
    let sourceEditor: monaco.editor.IStandaloneCodeEditor | undefined;
    let sourceModel: monaco.editor.ITextModel | undefined;
    let sourceTools: AttachedSource | undefined;
    let offSourceLayout: (() => void) | undefined;
    let offSourceFollow: (() => void) | undefined;
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
      // a structured document's file text is its codec's (every structured
      // notation has one, packages/notations/codecs.ts holds them together)
      const codec = structuredDoc && notation ? docCodecFor(notation.id) : undefined;
      const docText = structuredDoc ? (codec ? liveDocText(session, codec) : undefined) : liveDocText(session);
      docTextRef.current = docText ?? null;
      if (plugin?.mountEditor && canvasRef.current) {
        // the engine chunk loads HERE — the eager bundle carries no editor
        // engine. A failed chunk load (offline, stale deploy rotating hashed
        // asset URLs) must NOT strand the session: fall back to the text view
        // below — the ytext is already synced, editing works without the engine.
        // A structured document's source only shows: it is read-only.
        let editor: MountedEditor | undefined;
        try {
          mounting = plugin.mountEditor(canvasRef.current, {
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
            sync: {
              awareness: session.awareness,
              onUnrenderable: (message) => {
                if (!cancelled) setUnrenderable(message);
              },
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
              // whatever the cached list's age: a board asks before it
              // follows a model the list no longer shows
              refresh: async () => {
                // a list request already on its way may have left before the
                // move: fetchQuery would join it, so it goes first and the
                // answer comes from a request sent after the board asked
                await qc.cancelQueries({ queryKey: ["models", repo], exact: true });
                await qc.fetchQuery({ queryKey: ["models", repo], queryFn: () => fetchModels(repo), staleTime: 0 });
                // the cache's copy, not the fetched one: it keeps what did
                // not change, so a list that loads as it was is no new version
                if (!cancelled) showModelsRef.current(qc.getQueryData<ModelInfo[]>(["models", repo]));
              },
            },
            repoWeb: plugin.githubLinks
              ? {
                  get: () => repoWebRef.current,
                  onChange: (cb) => {
                    repoWebListenersRef.current.add(cb);
                    return () => repoWebListenersRef.current.delete(cb);
                  },
                }
              : undefined,
            visibility: {
              visible: () => canvasShownRef.current,
              onChange: (cb) => {
                canvasShownListenersRef.current.add(cb);
                return () => canvasShownListenersRef.current.delete(cb);
              },
            },
            presence: presenceSurface,
            menuTrigger: () => menuTriggerRef.current,
            revealCanvas: () => views.reveal(),
            sidePanels: sidePanelRoom(
              () => layersRef.current,
              () => canvasRef.current,
            ),
            onActionFailed: (message) => {
              if (!cancelled) toast.error(message);
            },
            // throws once this effect's cleanup ran (lib/linked-files.ts)
            linkedFiles: linked.files,
          });
          editor = await mounting;
        } catch (e) {
          if (!cancelled) {
            const failure = `${notation?.label ?? "Model"} editor failed to load (${e instanceof Error ? e.message : String(e)})`;
            toast.error(
              structuredDoc
                ? `${failure}. Its source shows, read-only: reload the page to edit the ${noun}.`
                : `${failure} — falling back to the text view.`,
            );
            views.fallBack(); // not a choice: never remembered
          }
        } finally {
          mounting = undefined;
        }
        if (cancelled) {
          // unmounted while the chunk loaded — tear the late editor down (the
          // cleanup ends the linked files once it let go of them)
          editor?.destroy();
          return;
        }
        mounted = editor;
        mountedRef.current = editor;
        setEditorActions(editor?.actions ?? []);
        setEditorMenu(editor?.menu);
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
      // a structured document's source is the text it is saved as, read-only:
      // no binding to CONTENT_KEY, it follows the element maps instead
      const readOnlySource = structuredDoc ? docText : undefined;
      if (sourceRef.current && (!structuredDoc || readOnlySource)) {
        // before the model: a Markdown source tokenizes its fences in the
        // languages it names, a structured one's lines are "jsonl"
        installMonacoLanguages(monaco.languages);
        sourceModel = monaco.editor.createModel(
          readOnlySource ? readOnlySource.read() : ytext.toString(),
          monacoLanguage(docPath),
        );
        installMonacoTheme(monaco.editor);
        sourceEditor = monaco.editor.create(sourceRef.current, {
          ...MONACO_OPTIONS,
          model: sourceModel,
          minimap: { enabled: false },
          // prose: a paragraph is one line, and half the width (the split
          // view) must not scroll it sideways
          wordWrap: sourceModel.getLanguageId() === "markdown" ? "on" : "off",
          ...(readOnlySource
            ? {
                readOnly: true,
                readOnlyMessage: { value: `A ${noun} is edited on its canvas. This is the text it is saved as.` },
              }
            : {}),
        });
        offSourceLayout = layoutBesideSidePanels(
          sourceEditor,
          sourceRef.current,
          sidePanelRoom(
            () => layersRef.current,
            () => sourceRef.current,
          ),
        );
        if (readOnlySource) {
          const model = sourceModel;
          offSourceFollow = readOnlySource.follow((text) => showText(model, text), SOURCE_REST_MS);
        } else {
          monacoBinding = new MonacoBinding(
            ytext,
            sourceModel,
            new Set([sourceEditor]),
            session.awareness ?? undefined,
          );
        }
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
    // still connecting after 10s → tell the user it's taking a while, keep
    // waiting; a room the host refused or closed meanwhile stays Offline
    const slow = setTimeout(() => {
      if (!cancelled && !attached) setStatus((now) => (now === "error" ? now : "slow"));
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
      docTextRef.current = null;
      todoCanvasRef.current = null;
      mountedRef.current = undefined;
      setEditorActions([]);
      setEditorMenu(undefined);
      setSourceMenus([]);
      setUnrenderable(null);
      mounted?.destroy();
      // the linked files' socket goes once the editor that opened them let go
      // of them (MountedEditor.unmounted): the mounted one, or one whose mount
      // is still on its way, which attach() destroys when it arrives. open()
      // refuses from here on
      const late = mounting;
      linked.close(
        mounted
          ? mounted.unmounted
          : late?.then(
              (editor) => editor.unmounted,
              () => undefined,
            ),
      );
      sourceTools?.dispose();
      monacoBinding?.destroy();
      offSourceFollow?.();
      offSourceLayout?.();
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
  const takenIds = new Set((models.data ?? []).filter((m) => m.notation === self.notation).map((m) => m.id));
  const openModel = useOpenModel(repo);
  const qc = useQueryClient();
  const knownModels = models.data;
  // the mounted editor's model paths follow the list
  useEffect(() => showModelsRef.current(knownModels), [knownModels]);
  // only an editor that reads links to the repository on GitHub looks its
  // default branch up: the repository list is the overview's costly read model
  const githubBase = useConfig().data?.githubBaseUrl;
  const defaultBranch = useDefaultBranch(repo, plugin?.githubLinks === true);
  useEffect(() => {
    repoWebRef.current = githubBase && defaultBranch ? { base: githubBase, defaultBranch } : undefined;
    for (const cb of repoWebListenersRef.current) cb();
  }, [githubBase, defaultBranch]);
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
      // the live document as its file's text (a structured one: its codec's)
      const current = docTextRef.current?.read();
      if (current === undefined) return; // session not attached — nothing to diff against
      setDiff({ commit, historical, current });
    },
    onError: onActionError,
  });

  // Restore: write the commit's content into the live document for every
  // client (lib/live-doc-text): a minimal diff into the shared Y.Text, which
  // the canvas binding re-imports, or a structured document's elements one
  // by one. A version that cannot be written back whole is refused, and a
  // restore that changes nothing says so instead of reporting a write
  const restore = useMutation({
    mutationFn: fetchCommitContent,
    onSuccess: ({ commit, historical, seq }) => {
      if (seq !== actionSeqRef.current || !aliveRef.current) return; // superseded or editor gone
      const doc = docTextRef.current;
      if (!doc) {
        return void toast.error("Restore cancelled — the live session ended before the commit content arrived.");
      }
      const version = commit.sha.slice(0, 7);
      const outcome = doc.restore(historical);
      if (outcome.kind === "refused") {
        return void toast.error(`${fileName} cannot be restored to ${version}`, {
          description: `${upperFirst(outcome.reason)}. Restoring it would drop that content, so nothing was written.`,
        });
      }
      setDiff(null);
      if (outcome.kind === "unchanged") {
        return void toast(`${fileName} already matches ${version}`, { description: "Nothing to restore." });
      }
      toast.success(`Restored ${fileName} to ${version}`, { description: commit.subject });
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
  // the mounted editor follows the view switch (see canvasShownRef), and a
  // click on the canvas view hands it the focus once it shows
  useEffect(() => {
    canvasShownRef.current = canvasShown;
    for (const cb of canvasShownListenersRef.current) cb();
    viewFocus.shown();
  }, [canvasShown, viewFocus]);
  // a shared text that stays unrenderable leaves the canvas on an older
  // state than the document, so whoever sees the canvas alone is told, and
  // offered the source, where the text shows as it is (#296)
  useEffect(() => {
    if (unrenderable === null || sourceShown) return undefined;
    const id = toast.warning(unrenderable, {
      duration: Infinity,
      action: { label: "Show source", onClick: () => setView("source") },
    });
    return () => void toast.dismiss(id);
  }, [unrenderable, sourceShown]);

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
    ...(p.modelMenu ? { modelMenu: true } : {}),
  }));
  const toolbarPanels: ToolbarPanelItem[] = [
    ...pluginPanels.filter((p) => p.placement !== "menu"),
    ...(hasTodos
      ? [
          {
            id: "todos",
            label: "Todos",
            title: `Open todos for this ${noun}`,
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
          // a structured document: its canvas or its read-only source (never split)
          isVisual
            ? {
                canvas: plugin?.canvasView,
                sourceLabel,
                shown,
                split: splitAvailable,
                onChange: (next, pointer) => {
                  views.choose(next);
                  viewFocus.chose(next, pointer);
                },
              }
            : undefined
        }
        panels={toolbarPanels}
        menuPanels={menuPanels}
        activePanel={panel}
        onTogglePanel={togglePanel}
        addTodo={
          hasTodos ? { selectionCount: selectedElements.length, noun, onAdd: () => setTodoCreateOpen(true) } : undefined
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
        modelerMenu={editorMenu}
        menuTriggerRef={menuTriggerRef}
        canvas={canvasFocus}
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
            Inert alone also keeps it out of the pointer's way
            (HIDDEN_LAYER_CLASS says why it has to).
            The split view only narrows the SAME two nodes: moved into another
            tree, React would make new ones, and the engines mounted once per
            session would stay on the old. The source comes first, so the Tab
            order follows the screen: source, divider, canvas */}
        <div
          ref={sourceRef}
          id={sourcePaneId}
          inert={!sourceShown}
          className={cn("monaco-host absolute inset-0", !sourceShown && HIDDEN_LAYER_CLASS)}
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
          className={cn(plugin?.canvasClassName, "absolute inset-0", !canvasShown && HIDDEN_LAYER_CLASS)}
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
        {todoModel && panel === "todos" && (
          <TodoPanel
            repo={repo}
            model={todoModel}
            noun={noun}
            todos={todoList}
            isLoading={todosQuery.isLoading}
            error={todosQuery.error}
            filterElementId={todoFilter}
            filterAnchorIds={todoFilter ? todoCanvasRef.current?.anchorIds?.(todoFilter) : undefined}
            onClearFilter={() => setTodoFilter(null)}
            onRevealElement={
              hasElements
                ? (elementId) => {
                    if (todoCanvasRef.current?.reveal(elementId)) views.reveal();
                    else toast(`Element '${elementId}' no longer exists in the diagram.`);
                  }
                : undefined
            }
            onClose={closePanel}
          />
        )}
      </div>
      {todoModel && todoCreateOpen && (
        <TodoCreateDialog
          repo={repo}
          model={todoModel}
          noun={noun}
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
