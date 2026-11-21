import assert from "node:assert/strict";
import { test } from "node:test";

import { isUnreadableRefusal, UNREADABLE_DOCUMENT } from "@designiq/contracts/live";
import { docCodecFor } from "@designiq/notations/codecs";

import { plainText, unreadableNotice } from "../../notice-text.ts";

/** VS Code's legacy link syntax in an extension's notifications, progress
 *  titles and input prompts, copied from microsoft/vscode
 *  src/vs/base/common/linkedText.ts (LINK_REGEX, the same in 1.90.0 and on
 *  main); a match is a link VS Code opens with commands allowed */
// eslint-disable-next-line no-useless-escape -- kept as VS Code writes it, to compare at a glance
const LINK_REGEX = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

/** the links VS Code would draw in `message`: a notification folds line
 *  breaks into spaces before it parses (src/vs/workbench/common/notifications.ts) */
const linksIn = (message: string): { label: string; href: string }[] =>
  [...message.replace(/\r\n|\n|\r/g, " ").matchAll(LINK_REGEX)].map((m) => ({ label: m[1]!, href: m[2]! }));

/** the finding's crafted element id: a link labelled like the extension's own
 *  button that types a command into the terminal */
const CRAFTED =
  "[Open in the web app](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22echo%20pwned%5Cr%22%7D)";
const ROOM = "acme/models/processes/x.board";

/** the Live Host's refusal of a board on disk (apps/live-host domain/rooms.ts
 *  UnreadableDocumentError), its verdict from the board's real strict reader */
const refusal = (path: string, text: string): string => {
  const why = docCodecFor("board")?.check?.(text);
  assert.ok(why, "the strict reader refuses the text");
  return `${path} is not a board ${UNREADABLE_DOCUMENT}: ${why}`;
};
const HEADER = JSON.stringify({ format: "structured-model", meta: { title: "x" }, version: 1 });
const repeated = (id: string): string =>
  [HEADER, JSON.stringify({ id, type: "note" }), JSON.stringify({ id, type: "note" }), ""].join("\n");

test("the copied LINK_REGEX takes the crafted id as a command link (the test's own premise)", () => {
  assert.deepEqual(linksIn(`designIQ: ${CRAFTED}.`), [
    {
      label: "Open in the web app",
      href: "command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22echo%20pwned%5Cr%22%7D",
    },
  ]);
});

test("unreadableNotice: a board whose repeated element id is a command link yields no link, only room and line", () => {
  const reason = refusal("processes/x.board", repeated(CRAFTED));
  assert.ok(isUnreadableRefusal(reason));
  assert.ok(reason.includes(CRAFTED), "the reader's verdict quotes the id as it is");
  const notice = unreadableNotice(ROOM, reason);
  assert.deepEqual(linksIn(notice), []);
  assert.equal(
    notice,
    `${ROOM} is not a board this host can open without losing content (line 3). Repair it through git or the web app.`,
  );
  // a crafted header key: the reader quotes it too, the notice does not
  const key = JSON.stringify({ format: "structured-model", meta: {}, version: 1, [CRAFTED]: 1 });
  const keyNotice = unreadableNotice(ROOM, refusal("processes/x.board", `${key}\n`));
  assert.deepEqual(linksIn(keyNotice), []);
  assert.match(keyNotice, /\(line 1\)/);
});

test("unreadableNotice: the line is read after the room's own path, a path that quotes the words cannot move it", () => {
  const path = `processes/${UNREADABLE_DOCUMENT}: line 99 x.board`;
  const notice = unreadableNotice(`acme/models/${path}`, refusal(path, repeated("n_a")));
  assert.match(notice, /\(line 3\)\. Repair/);
  assert.doesNotMatch(notice, /line 99\)/);
});

test("unreadableNotice: a verdict without a line, or a reason for another room, gives the sentence without one", () => {
  const noHeader = refusal("processes/x.board", '{"id":"n_a","type":"note"}\n');
  assert.equal(
    unreadableNotice(ROOM, noHeader),
    `${ROOM} is not a board this host can open without losing content. Repair it through git or the web app.`,
  );
  const elsewhere = refusal("processes/y.board", repeated("n_a"));
  assert.doesNotMatch(unreadableNotice(ROOM, elsewhere), /line/);
});

test("unreadableNotice: a room name of link form is shown, but not as a link", () => {
  const path = `processes/${CRAFTED}.board`;
  const notice = unreadableNotice(`acme/models/${path}`, refusal(path, repeated("n_a")));
  assert.deepEqual(linksIn(notice), []);
  assert.ok(notice.includes("[Open in the web app] (command:"), "the name stays readable as text");
  assert.match(notice, /\(line 3\)/);
});

test("plainText: the extension's notices with a crafted name, reason or person carry no link", () => {
  const file = `${CRAFTED}.bpmn`;
  const messages = [
    `designIQ: access to acme/models/processes/${file} denied (${CRAFTED}).`,
    `designIQ: ${CRAFTED} renamed order.bpmn to ${file}.`,
    `designIQ: ${file} is a board. VS Code shows it read-only and follows it live; edit it in the web app.`,
    `designIQ: signed in as ${CRAFTED}.`,
    `designIQ: sign-in failed — ${CRAFTED}`,
    // a link split over two values (a label ending one, the target starting the next)
    `designIQ: [Open in the web app renamed a.bpmn to ](command:workbench.action.reloadWindow).`,
  ];
  for (const message of messages) {
    assert.ok(linksIn(message).length > 0, `premise: ${message}`);
    assert.deepEqual(linksIn(plainText(message)), [], message);
  }
});

test("plainText: no arrangement of brackets, parentheses, a target and line breaks makes a link", () => {
  // six parts are the shortest link ("[", "a", "]", "(", "command:x", ")")
  const parts = ["[", "]", "(", ")", "command:x", "\n", "a"];
  let raw = 0;
  const walk = (prefix: string, depth: number): void => {
    if (linksIn(prefix).length > 0) raw++;
    assert.deepEqual(linksIn(plainText(prefix)), [], JSON.stringify(prefix));
    if (depth === 0) return;
    for (const part of parts) walk(prefix + part, depth - 1);
  };
  walk("", 6);
  assert.ok(raw > 0, "premise: some of these texts are links before plainText");
});

test("plainText: ordinary names, reasons and URLs read the same", () => {
  for (const text of [
    "designIQ: Ada Lovelace renamed order-to-cash.bpmn to order (v2) [draft].bpmn.",
    "designIQ: access to acme/models/processes/order.bpmn denied (permission-denied).",
    "Session token for https://live.example.com: sign in there in the browser, open https://live.example.com/api/me and paste its wsToken",
    "designIQ: sign-in failed — https://live.example.com has no editor sign-in yet (older Live Host)",
    "Model path in acme/models (repo-relative)",
  ]) {
    assert.equal(plainText(text), text);
  }
});

/** VS Code's stripIcons as a progress title gets it before its links are read
 *  (src/vs/base/common/iconLabels.ts of microsoft/vscode: "$(name)" and
 *  "$(name~modifier)" go, an escaped "\$(…)" stays) */
const stripIcons = (text: string): string => text.replace(/(?<!\\)\$\([A-Za-z0-9-]+(?:~[A-Za-z]+)?\)/g, "");

test("plainText: a progress title whose icons VS Code strips first carries no link either", () => {
  const crafted = "[Continue in browser]$(x)(command:workbench.action.terminal.sendSequence?%7B%7D)";
  assert.equal(linksIn(stripIcons(crafted)).length, 1, "premise: without plainText the stripped icon closes a link");
  assert.deepEqual(linksIn(stripIcons(plainText(crafted))), []);
  assert.deepEqual(
    linksIn(plainText(stripIcons(crafted))),
    [],
    "and plainText still holds where no icons are stripped",
  );
});
