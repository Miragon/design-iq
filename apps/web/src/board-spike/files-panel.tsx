/**
 * The Files panel: the spike's "repository" as the hub holds it right now, and the text of one
 * file. It is how a person SEES where an edit went: a gesture on the board (move, resize, add,
 * connect, rename) changes `boards/workshop.board` and no model file, an edit inside a model
 * changes that model's own file and not the board file.
 *
 * So the panel follows the changes: the file that changed last is the one it shows, its row
 * flashes, its change count goes up, and the lines that are new are marked. The board file has one
 * line per node and arrow, so a moved node is exactly one marked line. Picking a file by hand pins
 * it, "Follow" lets go again.
 */
import { byExtension } from "@designiq/notations";
import { FileImage, LayoutDashboard, type LucideIcon, PanelRightClose, PanelRightOpen, Radio } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { notationIcon } from "@/components/notation-icon";

import { changedLines, formatBytes, IMAGE_LIMIT_BYTES, type LineChange } from "../notations/board/board-actions.ts";
import { useBoardContext } from "../notations/board/board-context.tsx";
import type { BoardFiles, FileKind, ListedFile as HubFile } from "../notations/board/files.ts";
import { BOARD_PATH } from "./samples.ts";

/** what the panel remembers of a file, to tell what its last change was */
interface Seen {
  version: number;
  /** undefined for an asset */
  text: string | undefined;
  /** the lines its last change brought, and how many it took away */
  change: LineChange;
  /** when it changed last (ms); 0: not since the page loaded */
  at: number;
  /** how often it changed since the page loaded (an asset: 1 once it was added) */
  count: number;
}
interface Watch {
  files: HubFile[];
  seen: ReadonlyMap<string, Seen>;
  /** the file that changed last */
  last: string | null;
}

const NO_CHANGE: LineChange = { changed: [], removed: 0 };

/** the hub's files now, against what was seen before; `at` is the time of the event that asked */
function watch(hub: BoardFiles, previous: Watch | undefined, at: number): Watch {
  const files = hub.files();
  const seen = new Map<string, Seen>();
  let last = previous?.last ?? null;
  for (const file of files) {
    const before = previous?.seen.get(file.path);
    if (before && before.version === file.version) {
      seen.set(file.path, before);
      continue;
    }
    const text = file.kind === "asset" ? undefined : hub.text(file.path);
    if (!previous) {
      // what the page loaded with is no change
      seen.set(file.path, { version: file.version, text, change: NO_CHANGE, at: 0, count: 0 });
      continue;
    }
    const change = before?.text !== undefined && text !== undefined ? changedLines(before.text, text) : NO_CHANGE;
    seen.set(file.path, { version: file.version, text, change, at, count: (before?.count ?? 0) + 1 });
    last = file.path;
  }
  return { files, seen, last };
}

function useFileWatch(hub: BoardFiles): Watch {
  const [state, setState] = useState(() => watch(hub, undefined, 0));
  const latest = useRef(state);
  useEffect(
    () =>
      hub.onFiles(() => {
        // Read at the event, not in a state updater: an image that is added is two events in one
        // task (the file, then the board's new node), and an updater would see both at once and
        // could not tell which came last.
        latest.current = watch(hub, latest.current, Date.now());
        setState(latest.current);
      }),
    [hub],
  );
  return state;
}

const KINDS: ReadonlyArray<{ kind: FileKind; title: string; note?: string }> = [
  { kind: "model", title: "Models" },
  { kind: "board", title: "Board" },
  { kind: "asset", title: "Assets", note: `images up to ${formatBytes(IMAGE_LIMIT_BYTES)}` },
];
const ABOUT: Readonly<Record<FileKind, string>> = {
  model: "A model's own file. An edit inside the model on the board is written here, and only here.",
  board: "The board file: one line per node and arrow, saying where it is and which file it shows. No model content.",
  asset: "A repository file. An image node on the board holds this path and nothing else.",
};

const iconOf = (file: HubFile): LucideIcon =>
  file.kind === "board"
    ? LayoutDashboard
    : file.kind === "asset"
      ? FileImage
      : notationIcon(byExtension(file.path)?.id ?? "");
const splitPath = (path: string): [folder: string, name: string] => {
  const slash = path.lastIndexOf("/") + 1;
  return [path.slice(0, slash), path.slice(slash)];
};
const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

function describe(seen: Seen | undefined): string {
  if (!seen || seen.count === 0) return "Unchanged since the page loaded.";
  if (seen.text === undefined) return "Added since the page loaded.";
  const { changed, removed } = seen.change;
  const parts = [
    changed.length > 0 ? `${plural(changed.length, "line")} written` : "",
    removed > changed.length ? `${plural(removed - changed.length, "line")} removed` : "",
  ].filter(Boolean);
  return `Changed ${seen.count === 1 ? "once" : `${seen.count} times`}. Last change: ${parts.join(", ") || "no line differs"}.`;
}

export function FilesPanel() {
  const { hub } = useBoardContext();
  const { files, seen, last } = useFileWatch(hub);
  const [collapsed, setCollapsed] = useState(false);
  const [picked, setPicked] = useState(BOARD_PATH);
  const [follow, setFollow] = useState(true);
  const path = follow && last !== null ? last : picked;
  const file = files.find((one) => one.path === path);
  const shown = seen.get(path);

  if (collapsed) {
    return (
      <div className="board-files" data-collapsed="true">
        <button
          type="button"
          className="board-files__toggle"
          title="Show the files"
          aria-label="Show the files"
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
        >
          <PanelRightOpen aria-hidden />
        </button>
        <span className="board-files__rail">Files</span>
      </div>
    );
  }

  return (
    <div className="board-files" data-collapsed="false">
      <header className="board-files__header">
        <div>
          <div className="board-files__title">Files</div>
          <div className="board-files__lead">The repository as it is right now.</div>
        </div>
        <button
          type="button"
          className="board-files__follow"
          title={
            follow
              ? "Shows the file that changed last. Pick a file to pin it."
              : "Show the file that changed last again"
          }
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
        >
          <Radio aria-hidden />
          Follow
        </button>
        <button
          type="button"
          className="board-files__toggle"
          title="Hide the files"
          aria-label="Hide the files"
          aria-expanded
          onClick={() => setCollapsed(true)}
        >
          <PanelRightClose aria-hidden />
        </button>
      </header>

      <div className="board-files__last" role="status" data-any={last !== null}>
        {last === null ? (
          "Nothing changed yet. Move a node, or edit inside a model."
        ) : (
          <>
            <span key={seen.get(last)?.at} className="board-files__pulse" aria-hidden />
            <span>
              Last change went into <code>{last}</code>
            </span>
          </>
        )}
      </div>

      <nav className="board-files__list" aria-label="Files">
        {KINDS.map(({ kind, title, note }) => {
          const group = files.filter((one) => one.kind === kind);
          return (
            <section key={kind} data-kind={kind}>
              <h3 className="board-files__kind">
                {title}
                <span>{note ?? group.length}</span>
              </h3>
              {group.map((one) => {
                const Icon = iconOf(one);
                const [folder, name] = splitPath(one.path);
                const state = seen.get(one.path);
                return (
                  <button
                    key={one.path}
                    type="button"
                    className="board-files__file"
                    data-path={one.path}
                    data-changes={state?.count ?? 0}
                    aria-current={one.path === path}
                    title={one.path}
                    onClick={() => {
                      setPicked(one.path);
                      setFollow(false);
                    }}
                  >
                    {/* a new element per change: the flash runs again */}
                    {state && state.at > 0 ? <span key={state.at} className="board-files__flash" aria-hidden /> : null}
                    <Icon aria-hidden />
                    <span className="board-files__name">{name}</span>
                    <span className="board-files__folder">{folder}</span>
                    {state && state.count > 0 ? (
                      <span className="board-files__count" title={describe(state)}>
                        {kind === "asset" ? "new" : `${state.count}×`}
                      </span>
                    ) : null}
                    <span className="board-files__size">{formatBytes(one.bytes)}</span>
                  </button>
                );
              })}
            </section>
          );
        })}
      </nav>

      {file ? (
        <section className="board-files__view" aria-label={path} data-path={path} data-kind={file.kind}>
          <div className="board-files__about">
            <code>{path}</code>
            <p>{ABOUT[file.kind]}</p>
            <p className="board-files__change" data-changed={(shown?.count ?? 0) > 0}>
              {describe(shown)}
            </p>
          </div>
          {shown?.text !== undefined ? (
            <FileText text={shown.text} change={shown.change} stamp={shown.at} />
          ) : (
            <AssetView hub={hub} file={file} />
          )}
        </section>
      ) : null}
    </div>
  );
}

/** the file's text, line by line; the lines its last change brought are marked and scrolled to */
function FileText({ text, change, stamp }: { text: string; change: LineChange; stamp: number }) {
  const list = useRef<HTMLOListElement>(null);
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const changed = useMemo(() => new Set(change.changed), [change]);
  useEffect(() => {
    const box = list.current;
    const first = box?.querySelector<HTMLElement>('[data-changed="true"]');
    if (!box) return;
    // within the list only: scrollIntoView would also move whatever else can scroll
    box.scrollTop = first ? Math.max(0, first.offsetTop - box.clientHeight / 3) : 0;
  }, [stamp]);
  return (
    <ol ref={list} className="board-files__lines">
      {lines.map((line, index) => (
        <li key={index} data-changed={changed.has(index)}>
          {line}
        </li>
      ))}
    </ol>
  );
}

function AssetView({ hub, file }: { hub: BoardFiles; file: HubFile }) {
  const blob = hub.asset(file.path);
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : undefined), [blob]);
  useEffect(() => () => void (url !== undefined && URL.revokeObjectURL(url)), [url]);
  return (
    <figure className="board-files__asset">
      {url !== undefined ? <img src={url} alt={file.path} /> : null}
      <figcaption>
        {blob?.type ?? "no such file"}, {formatBytes(file.bytes)}
      </figcaption>
    </figure>
  );
}
