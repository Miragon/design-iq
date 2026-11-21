/**
 * The text of the extension's notices: pure (no vscode API), unit-tested in
 * src/test/unit/notice-text.test.ts.
 *
 * VS Code reads a legacy link syntax in an extension's notifications, its
 * progress titles and its input box prompts: `[label](command:…)` becomes a
 * link, and a click on it runs the command, whatever it is (LINK_REGEX in
 * src/vs/base/common/linkedText.ts of microsoft/vscode). A file name, a
 * board's element id, a person's name or a reason the Live Host sends can
 * have that form, so every such text goes through plainText before VS Code
 * shows it.
 */
import { UNREADABLE_DOCUMENT } from "@designiq/contracts/live";

import { structuredNoun } from "./structured-room.ts";

/**
 * `text` as VS Code shows it plain: the link syntax has no escape, it needs a
 * "](" with nothing in between, so every "](" gets a space. A progress title
 * first loses its icons (stripIcons deletes "$(name)"), which would close a
 * "]$(x)(" back into "](" after this ran, so every "$(" gets a space too and
 * is no icon any more. Everything else stays as it is, an ordinary name reads
 * the same.
 */
export function plainText(text: string): string {
  return text.replaceAll("$(", "$ (").replaceAll("](", "] (");
}

/**
 * The notice for a room the Live Host refused because its file cannot be
 * opened without losing content (isUnreadableRefusal): a fixed sentence with
 * the room and the line the strict reader stopped at. The reader's own words
 * stay out, they quote the file (an element id, a header key); the web app
 * shows them as text.
 */
export function unreadableNotice(room: string, reason: string): string {
  const line = refusedLine(room, reason);
  const at = line === undefined ? "" : ` (line ${line})`;
  return plainText(
    `${room} is not a ${structuredNoun(room)} ${UNREADABLE_DOCUMENT}${at}. Repair it through git or the web app.`,
  );
}

/** the line the strict reader names in a refusal ("<path> is not a board
 *  this host can open without losing content: line 3 is no JSON"), read right
 *  after the room's own repo-relative path, so a path or an id that quotes
 *  these words cannot move it; undefined when the reason names no line */
function refusedLine(room: string, reason: string): string | undefined {
  const marker = `${UNREADABLE_DOCUMENT}: `;
  const segments = room.split("/");
  for (let i = 0; i < segments.length; i++) {
    const head = `${segments.slice(i).join("/")} is not a `;
    if (!reason.startsWith(head)) continue;
    const at = reason.indexOf(marker, head.length);
    if (at >= 0) return /^line (\d+)\b/.exec(reason.slice(at + marker.length))?.[1];
  }
  return undefined;
}
