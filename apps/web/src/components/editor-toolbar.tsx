/**
 * The editor's one chrome bar. It carries different KINDS of thing, and the
 * layout now says which is which instead of nine identical outline buttons in
 * a row:
 *
 *   identity   where you are — repo / model, connection, notation
 *   modes      document-level switches (t.BPM workshop mode) — they change the
 *              canvas FOR EVERYONE, so they sit with the document, not with
 *              the personal tools, and read as "on" when they are
 *   presence   who else is here — capped, the rest collapse into +N
 *   source     tools for the Monaco source a notation plugin contributes
 *              (Markdown: Insert diagram), there while the source is on
 *              screen. They sit before the view switch, so the switch never
 *              moves under the pointer as they come and go
 *   view       what you are looking at — a segmented Diagram | Source switch
 *              that states the CURRENT view (the old lone "XML" button did not);
 *              a plugin may name its canvas layer (Markdown: Preview) and add
 *              Split between the two, the source beside the canvas. A click
 *              on the canvas side hands the canvas the focus, so its keys
 *              work at once (lib/canvas-focus.ts)
 *   panels     what is docked beside the canvas — ONE cluster of toggles that
 *              show their open state. A notation plugin joins the cluster; it
 *              no longer grows the bar by another labelled button.
 *   actions    what you can do here (add todo, analyse with AI)
 *   menu       the ⋯ overflow, last: the occasional moves — panel toggles that
 *              earn no permanent button (Notes, History; open state shows as a
 *              check), the model's own Rename… / Duplicate… and Release → PR,
 *              and a Miragon renderer's own Model, Export and Help entries
 *              (Map size…, Level, Export as PNG, Keyboard shortcuts…) in the
 *              guide's group order around them. Not modal: a click outside
 *              closes it and acts on its target, a click on the canvas
 *              gives the canvas the focus
 *
 * The model name itself is the rename handle (#208): a quiet button that
 * shows a pencil on hover/focus and opens the Rename dialog on click. Not a
 * double-click-to-edit field — that has no affordance, collides with
 * selecting the name to copy it, and would commit a rename (new id, rewritten
 * links, migrated editors) on a stray blur.
 *
 * Tool labels collapse to icon + tooltip through container queries as the bar
 * narrows, cheapest first: the actions go at @7xl (a chat bubble and a
 * list-plus are guessable), the panel and source tool names hold on to @6xl
 * (they are the labels a once-a-month process owner actually needs), the view
 * switch to @4xl.
 */
import type { PresenceUser } from "@designiq/contracts/live";
import { Badge } from "@designiq/ui-kit/components/badge";
import { Button, focusRing } from "@designiq/ui-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@designiq/ui-kit/components/dropdown-menu";
import { cn } from "@designiq/ui-kit/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Code,
  Columns2,
  Copy,
  Ellipsis,
  FileCodeCorner,
  FileImage,
  GitPullRequest,
  Keyboard,
  ListPlus,
  Loader2,
  type LucideIcon,
  MessageSquareText,
  Pencil,
  Shapes,
} from "lucide-react";
import { type ComponentType, type ReactNode, type Ref, useEffect, useReducer, useRef, useState } from "react";

import { type FocusableCanvas, isPointerClick, type MenuCloseFocus, menuCloseFocus } from "@/lib/canvas-focus";
import type { EditorView } from "@/lib/editor-view";
import { safeAvatarUrl, safePresenceColor } from "@/lib/presence-format";
import { addTodoTitle } from "@/lib/todo-view";
import type { ModelerMenu, ModelerMenuEntry, ModelerMenuIcon } from "@/mcp-app/core/menu-model";
import type { CanvasViewLabel, EditorToolbarAction, SourceMenu } from "@/notations/registry";

export type EditorStatus = "connecting" | "slow" | "live" | "error";

/** a panel toggle — the shell's own (Todos, History) and the notation
 *  plugin's (Notes, Checks) render identically on purpose, whether they sit
 *  in the bar's cluster or in the ⋯ menu */
export interface ToolbarPanelItem {
  id: string;
  label: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  /** live count on the button (open todos); 0/undefined renders nothing */
  count?: number;
  /** the ⋯ menu's Model block repeats the toggle as a checkbox (the Legend) */
  modelMenu?: boolean;
}

/** faces beyond this collapse into a +N chip — a busy workshop must not push
 *  the tools off the bar */
const MAX_AVATARS = 4;

export function EditorToolbar({
  repo,
  title,
  subtitle,
  backDir,
  notationLabel,
  status,
  presence,
  modeActions,
  sourceMenus = [],
  view,
  panels,
  menuPanels,
  activePanel,
  onTogglePanel,
  addTodo,
  assist,
  onRelease,
  onRename,
  onDuplicate,
  modelerMenu,
  menuTriggerRef,
  canvas,
}: {
  /** repository full name, "owner/name" */
  repo: string;
  /** the model's own name — process id, or the file name */
  title: string;
  /** the file behind the title, when it is not the title itself */
  subtitle?: string;
  /** processes-root-relative folder the Back arrow returns to ("" = root) */
  backDir?: string;
  notationLabel?: string;
  status: EditorStatus;
  presence: PresenceUser[];
  /** document modes contributed by the mounted editor engine */
  modeActions: EditorToolbarAction[];
  /** tools for the Monaco source contributed by the plugin's source tooling,
   *  passed while the source is on screen */
  sourceMenus?: SourceMenu[];
  /** the view switch (Diagram | Source, or Preview | Split | Markdown for a
   *  plugin with the split view), absent when the doc has no visual editor;
   *  `canvas` renames the canvas side (absent = Diagram) */
  view?: ViewSwitchProps;
  panels: ToolbarPanelItem[];
  /** panel toggles living in the ⋯ overflow menu instead of the cluster */
  menuPanels: ToolbarPanelItem[];
  activePanel: string | null;
  onTogglePanel(id: string): void;
  /** `noun` names the model a todo without elements is filed on ("process", "document", …) */
  addTodo?: { selectionCount: number; noun: string; onAdd(): void };
  /** the Analyse-with-AI menu (owns its own trigger button) */
  assist?: ReactNode;
  onRelease(): void;
  /** open the Rename dialog — the title becomes its handle */
  onRename?: () => void;
  onDuplicate?: () => void;
  /** the mounted renderer's own entries (MountedEditor.menu) */
  modelerMenu?: ModelerMenu;
  /** the ⋯ trigger, where the renderer's dialogs give the focus back */
  menuTriggerRef?: Ref<HTMLButtonElement>;
  /** the canvas a click on a Model action of the ⋯ menu hands the focus to */
  canvas?: FocusableCanvas;
}) {
  const [owner = "", name = ""] = repo.split("/");
  const [closeFocus] = useState(menuCloseFocus);
  // a menu item that opens a DIALOG must not have radix hand the focus back
  // to the ⋯ trigger — it would steal the dialog field's autoFocus
  const openDialog = (open: () => void) => () => {
    closeFocus.openingDialog();
    setTimeout(open, 0);
  };
  const modelPanels = panels.filter((p) => p.modelMenu);
  const shownPeers = presence.slice(0, MAX_AVATARS);
  const hiddenPeers = presence.slice(MAX_AVATARS);

  return (
    <header className="@container bg-background flex items-center gap-2 border-b px-3 py-2">
      <Button asChild variant="ghost" size="icon" className="size-8 shrink-0" title={`Back to ${repo}`}>
        <Link to="/r/$owner/$repo" params={{ owner, repo: name }} search={backDir ? { dir: backDir } : {}}>
          <ArrowLeft />
        </Link>
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* the repo yields first and drops out below @4xl — one truncating
            string would eat the MODEL's name (the one word nobody can guess
            from context) while spelling the repo out in full */}
        <span className="flex min-w-0 items-center text-sm">
          <Link
            to="/r/$owner/$repo"
            params={{ owner, repo: name }}
            search={{}}
            className="text-muted-foreground hover:text-link @max-4xl:hidden truncate transition-colors"
            title={`All models in ${repo}`}
          >
            {repo}
          </Link>
          <span className="text-muted-foreground @max-4xl:hidden mx-1.5 shrink-0">/</span>
          {/* shrinks at a twentieth of the repo's rate: the repo gives up its
              characters first, the model name only once there is nothing left */}
          {onRename ? (
            <button
              type="button"
              onClick={onRename}
              title="Rename…"
              aria-label={`Rename ${title}`}
              className={cn(
                "group hover:bg-accent hover:text-accent-foreground -mx-1 flex min-w-0 shrink-[.05] cursor-pointer items-center gap-1 rounded-sm px-1 font-medium transition-colors",
                focusRing,
              )}
            >
              <span className="truncate">{title}</span>
              <Pencil
                aria-hidden="true"
                className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </button>
          ) : (
            <span className="min-w-0 shrink-[.05] truncate font-medium">{title}</span>
          )}
          {subtitle ? (
            <span className="text-muted-foreground ml-1.5 min-w-0 shrink-[.05] truncate">{subtitle}</span>
          ) : null}
        </span>
        {notationLabel ? (
          <Badge variant="outline" className="shrink-0">
            {notationLabel}
          </Badge>
        ) : null}
        <ConnectionState status={status} />
        {modeActions.map((action) => (
          <ModeAction key={action.id} action={action} />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {presence.length > 0 && (
          <>
            <div className="flex -space-x-1.5">
              {shownPeers.map((u, i) => (
                <PeerAvatar key={i} user={u} />
              ))}
              {hiddenPeers.length > 0 && (
                <div
                  className="border-background bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold"
                  title={hiddenPeers.map((u) => u.name).join(", ")}
                >
                  +{hiddenPeers.length}
                </div>
              )}
            </div>
            <Divider />
          </>
        )}

        {sourceMenus.length > 0 && (
          <div className="flex items-center gap-1">
            {sourceMenus.map((menu) => (
              <SourceMenuButton key={menu.id} menu={menu} />
            ))}
          </div>
        )}

        {view && <ViewSwitch {...view} />}

        {panels.length > 0 && (
          <div className="flex items-center gap-1">
            {panels.map((p) => {
              const open = activePanel === p.id;
              return (
                <Button
                  key={p.id}
                  variant="outline"
                  size="sm"
                  aria-pressed={open}
                  aria-label={p.label}
                  title={p.title}
                  onClick={() => onTogglePanel(p.id)}
                  // open = the CI's selection look: blue frame, blue-soft fill
                  className={cn(open && "border-primary bg-accent text-accent-foreground")}
                >
                  <p.icon />
                  <span className="@max-6xl:hidden">{p.label}</span>
                  {p.count ? <CountChip active={open}>{p.count}</CountChip> : null}
                </Button>
              );
            })}
          </div>
        )}

        {(addTodo || assist) && (
          <div className="flex items-center gap-1">
            {addTodo && (
              <Button
                variant="outline"
                size="sm"
                aria-label="Add todo"
                title={addTodoTitle(addTodo.selectionCount, addTodo.noun)}
                onClick={addTodo.onAdd}
              >
                <ListPlus />
                <span className="@max-7xl:hidden">Add todo</span>
                {addTodo.selectionCount > 0 ? <CountChip>{addTodo.selectionCount}</CountChip> : null}
              </Button>
            )}
            {assist}
          </div>
        )}

        <Divider />
        {/* not modal: a modal menu swallowed the click on the canvas that
            closed it and gave the trigger the focus, so the canvas keys
            waited for a second click (guide §5.4: a click outside acts on
            its target too) */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button ref={menuTriggerRef} variant="ghost" size="icon" className="size-8" aria-label="More" title="More">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(e) => {
              if (closeFocus.closing(canvas)) e.preventDefault();
            }}
          >
            {menuPanels.map((p) => (
              <DropdownMenuCheckboxItem
                key={p.id}
                checked={activePanel === p.id}
                title={p.title}
                onSelect={() => onTogglePanel(p.id)}
              >
                <p.icon />
                {p.label}
                {p.count ? <CountChip>{p.count}</CountChip> : null}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            {((modelerMenu?.model.length ?? 0) > 0 || modelPanels.length > 0) && (
              <>
                {modelerMenu && (
                  <ModelerEntries entries={modelerMenu.model} openDialog={openDialog} closeFocus={closeFocus} />
                )}
                {/* the guide's Model checkbox (§5.4, §5.10); it stays open on a
                    toggle like the renderer's own checkboxes */}
                {modelPanels.map((p) => (
                  <DropdownMenuCheckboxItem
                    key={p.id}
                    checked={activePanel === p.id}
                    title={p.title}
                    onCheckedChange={() => onTogglePanel(p.id)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <IconGap />
                    {p.label}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            {/* inset: the icon lines up with the panel entries' icons above.
                Rename/Duplicate open DIALOGS — mounted a tick after radix
                finished its close handling (the New menu's convention) */}
            {onRename && (
              <DropdownMenuItem inset onSelect={openDialog(onRename)}>
                <Pencil />
                Rename…
              </DropdownMenuItem>
            )}
            {onDuplicate && (
              <DropdownMenuItem inset onSelect={openDialog(onDuplicate)}>
                <Copy />
                Duplicate…
              </DropdownMenuItem>
            )}
            {(onRename || onDuplicate) && <DropdownMenuSeparator />}
            {modelerMenu && modelerMenu.export.length > 0 && (
              <>
                <ModelerEntries entries={modelerMenu.export} openDialog={openDialog} />
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem inset onSelect={onRelease}>
              <GitPullRequest />
              Release → PR
            </DropdownMenuItem>
            {modelerMenu && modelerMenu.help.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <ModelerEntries entries={modelerMenu.help} openDialog={openDialog} />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

const MODELER_ICONS: Record<ModelerMenuIcon, LucideIcon> = {
  "file-image": FileImage,
  "file-code-corner": FileCodeCorner,
  keyboard: Keyboard,
};

/** A renderer's menu entries in the ⋯ menu. Rendered inside the open menu,
 *  so a checkbox or a radio group reads the canvas's state as the menu
 *  opens; both stay open on a toggle (guide §5.4) and re-read it. A dialog
 *  entry opens a tick after radix let go of the focus, as Rename… does. An
 *  action entry of the Model group (`closeFocus`) tells how it was chosen:
 *  after a click the canvas takes the focus (guide §5.8). */
function ModelerEntries({
  entries,
  openDialog,
  closeFocus,
}: {
  entries: readonly ModelerMenuEntry[];
  openDialog: (open: () => void) => () => void;
  closeFocus?: MenuCloseFocus;
}) {
  const [, reread] = useReducer((n: number) => n + 1, 0);
  const keepOpen = (event: Event) => event.preventDefault();
  return entries.map((entry) => {
    if (entry.kind === "radio") {
      return (
        <DropdownMenuRadioGroup
          key={entry.id}
          aria-label={entry.label}
          value={entry.value() ?? ""}
          onValueChange={(value) => {
            if (value !== entry.value()) entry.onSelect(value);
            reread();
          }}
        >
          <DropdownMenuLabel aria-hidden="true" className="text-muted-foreground font-semibold">
            {entry.label}
          </DropdownMenuLabel>
          {entry.options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} onSelect={keepOpen}>
              <IconGap />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      );
    }
    if (entry.kind === "checkbox") {
      return (
        <DropdownMenuCheckboxItem
          key={entry.id}
          checked={entry.checked()}
          onCheckedChange={(checked) => {
            entry.onToggle(checked);
            reread();
          }}
          onSelect={keepOpen}
        >
          <IconGap />
          {entry.label}
        </DropdownMenuCheckboxItem>
      );
    }
    const Icon = entry.icon ? MODELER_ICONS[entry.icon] : undefined;
    return (
      <DropdownMenuItem
        key={entry.id}
        inset
        aria-haspopup={entry.kind === "dialog" ? "dialog" : undefined}
        // radix runs onSelect after this handler; its Enter and Space click with detail 0
        onClick={
          closeFocus && entry.kind === "action" ? (event) => closeFocus.actedOnCanvas(isPointerClick(event)) : undefined
        }
        onSelect={entry.kind === "dialog" ? openDialog(() => entry.onSelect()) : () => entry.onSelect()}
      >
        {Icon ? <Icon /> : <IconGap />}
        {entry.label}
        {entry.shortcut ? <DropdownMenuShortcut>{entry.shortcut}</DropdownMenuShortcut> : null}
      </DropdownMenuItem>
    );
  });
}

/** an entry without an icon keeps the icon's room, so the labels line up */
function IconGap() {
  return <span className="size-4 shrink-0" aria-hidden="true" />;
}

function Divider() {
  return <span className="bg-border h-5 w-px" aria-hidden="true" />;
}

function CountChip({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1 text-[10px] font-semibold tabular-nums",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Sync state as a quiet status line, not a permanent green badge: the happy
 *  case is a dot + one word, the deviations get the words they need. Colour is
 *  never the only signal — every state keeps its label and its title. */
function ConnectionState({ status }: { status: EditorStatus }) {
  if (status === "connecting" || status === "slow") {
    return (
      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs" role="status">
        <Loader2 className="size-3 animate-spin" />
        {status === "slow" ? "Still connecting…" : "Connecting…"}
      </span>
    );
  }
  const live = status === "live";
  return (
    <span
      role="status"
      title={
        live ? "Live — every edit syncs to everyone in this document" : "Offline — this document is no longer syncing"
      }
      className={cn("flex shrink-0 items-center gap-1.5 text-xs", live ? "text-muted-foreground" : "text-destructive")}
    >
      <span className={cn("size-1.5 rounded-full", live ? "bg-success" : "bg-destructive")} aria-hidden="true" />
      {live ? "Live" : "Offline"}
    </span>
  );
}

function PeerAvatar({ user }: { user: PresenceUser }) {
  const avatar = safeAvatarUrl(user.avatarUrl);
  // color is peer input landing in inline CSS — same guard as the canvas/caret
  // render sites (url(...) would fetch on paint)
  const background = safePresenceColor(user.color);
  // an AI client acting for someone (kind is server-asserted, see
  // @designiq/contracts/live): the assist menu's chat bubble on its color,
  // named after that person
  if (user.kind === "agent") {
    return (
      <div
        className="border-background text-background flex size-6 items-center justify-center rounded-full border-2"
        style={{ background }}
        title={user.name}
        aria-label={user.name}
      >
        <MessageSquareText className="size-3.5" aria-hidden="true" />
      </div>
    );
  }
  return avatar ? (
    <img
      className="border-background size-6 rounded-full border-2"
      src={avatar}
      alt={user.name}
      title={user.name}
      referrerPolicy="no-referrer"
      style={{ background }}
    />
  ) : (
    <div
      className="border-background text-background flex size-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold"
      style={{ background }}
      title={user.name}
    >
      {user.name.slice(0, 2).toUpperCase()}
    </div>
  );
}

/** A menu of the source tooling (Markdown: Insert diagram), its trigger a
 *  tool button like the assist menu's. An entry edits the Monaco source and
 *  gives it the focus, so the menu does not hand the focus back to its
 *  trigger once it closes, and the entry runs a tick later, once radix has
 *  let go of the focus (the ⋯ menu's convention for its dialogs). */
function SourceMenuButton({ menu }: { menu: SourceMenu }) {
  const chosen = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={menu.label} title={menu.buttonTitle}>
          <menu.icon />
          <span className="@max-6xl:hidden">{menu.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          if (!chosen.current) return;
          chosen.current = false;
          e.preventDefault();
        }}
      >
        {menu.heading ? (
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{menu.heading}</DropdownMenuLabel>
        ) : null}
        {menu.items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => {
              chosen.current = true;
              setTimeout(() => menu.run(item.id), 0);
            }}
          >
            <span className="flex flex-col">
              {item.label}
              {item.description ? <span className="text-muted-foreground text-xs">{item.description}</span> : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** the canvas side of the switch unless the plugin names it */
const DIAGRAM_VIEW: CanvasViewLabel = { label: "Diagram", buttonTitle: "Show the visual editor", icon: Shapes };

interface ViewSwitchProps {
  canvas?: CanvasViewLabel;
  sourceLabel: string;
  /** the view on screen */
  shown: EditorView;
  /** the Split segment: for a plugin with the split view while the editor
   *  has room for it. Without the room it leaves the switch, the preview
   *  shows, and a chosen Split comes back with the room */
  split?: boolean;
  /** `pointer`: chosen with a click, not Enter or Space */
  onChange(view: EditorView, pointer: boolean): void;
}

interface ViewOption {
  view: EditorView;
  label: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
}

/** Diagram | Source, or Preview | Split | Markdown. A segmented control
 *  states which view is CURRENT — the single "XML" button it replaces read
 *  the same in both. */
function ViewSwitch({ canvas = DIAGRAM_VIEW, sourceLabel, shown, split, onChange }: ViewSwitchProps) {
  const canvasName = canvas.label.toLowerCase();
  const options: ViewOption[] = [
    { view: "canvas", label: canvas.label, title: canvas.buttonTitle, icon: canvas.icon },
    ...(split
      ? [
          {
            view: "split" as const,
            label: "Split",
            title: `Show the ${sourceLabel} source and the ${canvasName} side by side`,
            icon: Columns2,
          },
        ]
      : []),
    { view: "source", label: sourceLabel, title: `Show the ${sourceLabel} source`, icon: Code },
  ];
  return (
    <div role="group" aria-label="Editor view" className="bg-muted flex h-8 items-center gap-0.5 rounded-md p-0.5">
      {options.map((o) => {
        const active = shown === o.view;
        return (
          <button
            key={o.view}
            type="button"
            aria-pressed={active}
            aria-label={o.label}
            title={o.title}
            onClick={(event) => onChange(o.view, isPointerClick(event))}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors",
              focusRing,
              active ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <o.icon className="size-3.5" />
            <span className="@max-4xl:hidden">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A document mode owned by the mounted editor ENGINE (MountedEditor.actions):
 *  the engine holds state and behavior, this only mirrors isActive(). The whole
 *  chip is the switch — the previous label sat OUTSIDE the control and clicking
 *  it did nothing — and it tints when on, because t.BPM changes the canvas for
 *  every participant. Actions without state render as a plain button. */
function ModeAction({ action }: { action: EditorToolbarAction }) {
  const [active, setActive] = useState(action.isActive?.() ?? false);
  useEffect(() => action.onChanged?.(() => setActive(action.isActive?.() ?? false)), [action]);
  if (!action.isActive) {
    return (
      <Button variant="outline" size="sm" className="shrink-0" title={action.buttonTitle} onClick={() => action.run()}>
        {action.label}
      </Button>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      title={action.buttonTitle}
      onClick={() => action.run()}
      className={cn(
        "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors",
        focusRing,
        active
          ? "border-primary bg-accent text-accent-foreground"
          : "bg-background text-muted-foreground hover:border-primary hover:text-link",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("relative h-3.5 w-6 rounded-full transition-colors", active ? "bg-primary" : "bg-input")}
      >
        {/* left-0.5 is load-bearing: a <button> carries the UA's
            text-align:center, which the track inherits, and Blink resolves an
            absolute child's static position from it — the knob started 12px in
            and slid out of the track onto the label. Pin it, then travel the
            10px the track actually has (24 − 2·2 − 10). */}
        <span
          className={cn(
            "bg-background absolute top-0.5 left-0.5 size-2.5 rounded-full shadow-xs transition-transform",
            active ? "translate-x-2.5" : "translate-x-0",
          )}
        />
      </span>
      {action.label}
    </button>
  );
}
