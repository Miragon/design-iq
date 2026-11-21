/**
 * The shell's side of EditorContext.linkedFiles (notations/registry.ts):
 * other files of the repository that a mounted editor shows in place (a
 * board shows its models), each a live session of its own on that file's
 * room.
 *
 * - One more socket for all of them (openLiveSessionGroup), opened with the
 *   first: the Live Host counts sockets per address (LIVE_MAX_WS_PER_IP),
 *   and a board of twenty models must not open twenty.
 * - Only the repository's listed models. A board file arrives through a
 *   pull request like any other, and the room of a path that is no model
 *   would become a new file once something writes into it. A structured
 *   document (a board) is never shown inside another one.
 * - The person is in a linked room's roster only while `present` says so
 *   (they edit that model on the board), announced as in the editor's own
 *   room: the same user object.
 * - A linked file that moves (its room's notice) makes the shell load its
 *   model list again (onMoved): the board opens the model at its new path,
 *   which open() takes only once the list has it.
 * - close(): the editor is closing. open() refuses from then on, or a late
 *   open would leave a second socket nobody ends. The socket itself ends
 *   only once the editor let go of its sessions (MountedEditor.unmounted): a
 *   board destroys its embedded editors a microtask or more after its own
 *   destroy(), and ending the sessions first would pull the documents out
 *   from under editors still bound to them (an armed editor's last commit
 *   would be lost).
 *
 * Pure: the socket group and the model list are parameters
 * (test/linked-files.test.ts).
 */
import type { MovedNotice, PresenceUser } from "@designiq/contracts/live";
import type { LiveSessionGroup } from "@designiq/live-client";
import { byExtension } from "@designiq/notations";

import type { LinkedFiles } from "@/notations/registry";

export interface LinkedFilesOptions {
  /** the repository's model paths as the shell has them; undefined while the list loads */
  listed(): ReadonlySet<string> | undefined;
  /** the live room of a repository path (@designiq/contracts/live roomName) */
  room(path: string): string;
  /** the one socket of every linked file */
  openGroup(): LiveSessionGroup;
  /** the person, as the editor's own room announces them */
  user: PresenceUser;
  /** a linked file was renamed or moved (its room's notice): the shell's
   *  model list is stale until it loads again, and open() refuses the new
   *  path until then. Absent: nobody is told */
  onMoved?(notice: MovedNotice): void;
}

export interface ShellLinkedFiles {
  /** what the mounted editor gets (EditorContext.linkedFiles) */
  readonly files: LinkedFiles;
  /** the editor is closing: open() refuses from now on, and the socket ends
   *  once `released` settled (MountedEditor.unmounted), at once without it */
  close(released?: Promise<unknown>): void;
}

/** why `path` is no linked file, undefined when it may be one */
export function linkedFileRefusal(path: string, listed: ReadonlySet<string> | undefined): string | undefined {
  const notation = byExtension(path);
  if (notation?.docShape === "structured") return `a ${notation.noun.singular} is not shown inside another model`;
  if (!listed?.has(path)) return `${path} is not a model of this repository`;
  return undefined;
}

export function linkedFiles(options: LinkedFilesOptions): ShellLinkedFiles {
  let group: LiveSessionGroup | undefined;
  let closed = false;
  return {
    files: {
      open(path) {
        if (closed) throw new Error("the editor was closed");
        const refusal = linkedFileRefusal(path, options.listed());
        if (refusal !== undefined) throw new Error(refusal);
        group ??= options.openGroup();
        const session = group.open(options.room(path));
        // the board follows the notice itself (it relocates the node); the list has to catch up
        const { onMoved } = options;
        if (onMoved) session.onMoved((notice) => onMoved(notice));
        return session;
      },
      present: (session, present) => session.setUser(present ? options.user : null),
    },
    close(released) {
      closed = true;
      const ending = group;
      group = undefined;
      if (!ending) return;
      const end = (): void => {
        try {
          ending.destroy();
        } catch (err) {
          // a provider that failed its teardown: the group still closed the socket
          console.error("closing the linked files failed", err);
        }
      };
      if (released) void released.then(end, end);
      else end();
    },
  };
}
