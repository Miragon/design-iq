/**
 * The shell's linked files (src/lib/linked-files.ts), what a board opens its
 * models through: one socket group opened with the first file, only listed
 * models (never a board), the person announced only while present, and the
 * teardown order: open() refuses as soon as the editor closes, the socket
 * ends only once the editor let go of its sessions (MountedEditor.unmounted).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { type MovedNotice, presenceColor, type PresenceUser } from "@designiq/contracts/live";
import type { LiveSession, LiveSessionGroup } from "@designiq/live-client";

import { linkedFileRefusal, linkedFiles } from "../src/lib/linked-files.ts";

const USER: PresenceUser = { name: "Ada", color: presenceColor("ada"), avatarUrl: "https://example.test/ada.png" };
const MODELS = new Set(["processes/order.bpmn", "processes/route.dmn", "maps/market.owm"]);

/** a session that records what it was told */
function fakeSession(room: string) {
  const announced: (PresenceUser | null)[] = [];
  const session = {
    room,
    announced,
    destroyed: false,
    setUser: (user: PresenceUser | null) => void announced.push(user),
    destroy() {
      session.destroyed = true;
    },
  };
  return session;
}
type FakeSession = ReturnType<typeof fakeSession>;

/** the shell's dependencies, recording the socket groups it opens */
function shell(listed: () => ReadonlySet<string> | undefined = () => MODELS) {
  const groups: { sessions: FakeSession[]; destroyed: number; failure?: Error }[] = [];
  const linked = linkedFiles({
    listed,
    room: (path) => `acme/models/${path}`,
    openGroup: () => {
      const group: (typeof groups)[number] = { sessions: [], destroyed: 0 };
      groups.push(group);
      return {
        open: (room) => {
          const session = fakeSession(room);
          group.sessions.push(session);
          return session as unknown as LiveSession;
        },
        destroy: () => {
          group.destroyed++;
          if (group.failure) throw group.failure;
        },
      } satisfies LiveSessionGroup;
    },
    user: USER,
  });
  return { linked, groups };
}

/** a promise settled from outside, like a board's unmounted */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** every promise reaction queued so far has run */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("one socket group for every linked file, opened with the first: no socket for an editor that links none", () => {
  const { linked, groups } = shell();
  assert.equal(groups.length, 0);
  const order = linked.files.open("processes/order.bpmn") as unknown as FakeSession;
  const map = linked.files.open("maps/market.owm") as unknown as FakeSession;
  // two nodes of a board on one model: two sessions of that room
  linked.files.open("processes/order.bpmn");
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]!.sessions.map((s) => s.room),
    ["acme/models/processes/order.bpmn", "acme/models/maps/market.owm", "acme/models/processes/order.bpmn"],
  );
  assert.deepEqual(order.announced, [], "a linked session is not announced when it opens");
  assert.deepEqual(map.announced, []);
});

test("only the repository's listed models: never a path the list lacks, never while it loads, never a board", () => {
  assert.equal(linkedFileRefusal("processes/order.bpmn", MODELS), undefined);
  assert.equal(linkedFileRefusal("processes/new.bpmn", MODELS), "processes/new.bpmn is not a model of this repository");
  assert.equal(
    linkedFileRefusal("processes/order.bpmn", undefined),
    "processes/order.bpmn is not a model of this repository",
  );
  // a board is no linked file even when listed (a board in a board is not supported)
  const withBoard = new Set([...MODELS, "boards/workshop.board"]);
  assert.equal(linkedFileRefusal("boards/workshop.board", withBoard), "a board is not shown inside another model");

  const { linked, groups } = shell();
  for (const path of ["processes/new.bpmn", "boards/workshop.board", "../../etc/passwd"]) {
    assert.throws(() => linked.files.open(path), /not a model of this repository|not shown inside/, path);
  }
  assert.equal(groups.length, 0, "a refused file opens no socket");
  const loading = shell(() => undefined);
  assert.throws(() => loading.linked.files.open("processes/order.bpmn"), /not a model/);
  assert.equal(loading.groups.length, 0);
});

test("present announces the person exactly as the editor's own room does, and takes it back", () => {
  const { linked } = shell();
  const session = linked.files.open("processes/route.dmn") as unknown as FakeSession;
  linked.files.present(session as unknown as LiveSession, true);
  linked.files.present(session as unknown as LiveSession, false);
  assert.equal(session.announced.length, 2);
  assert.equal(session.announced[0], USER, "the same user object");
  assert.equal(session.announced[1], null);
});

test("close: open() refuses at once, the socket ends only after the editor let go of its sessions", async () => {
  const { linked, groups } = shell();
  linked.files.open("processes/order.bpmn");
  const unmounted = deferred();
  linked.close(unmounted.promise);
  assert.throws(() => linked.files.open("processes/route.dmn"), /the editor was closed/);
  await settle();
  assert.equal(groups[0]!.destroyed, 0, "the board's editors may still be bound to their sessions");
  unmounted.resolve();
  await settle();
  assert.equal(groups[0]!.destroyed, 1);
  assert.equal(groups.length, 1, "no second socket");
  // a second close finds nothing left to end
  linked.close();
  await settle();
  assert.equal(groups[0]!.destroyed, 1);
});

test("close: without an unmount to wait for the socket ends at once, and a failed unmount ends it too", async () => {
  const atOnce = shell();
  atOnce.linked.files.open("processes/order.bpmn");
  atOnce.linked.close();
  assert.equal(atOnce.groups[0]!.destroyed, 1);

  const failed = shell();
  failed.linked.files.open("processes/order.bpmn");
  const unmounted = deferred();
  failed.linked.close(unmounted.promise);
  unmounted.reject(new Error("an embedded editor threw in its destroy"));
  await settle();
  assert.equal(failed.groups[0]!.destroyed, 1);

  // an editor that linked nothing: nothing to end, and no socket opened for it
  const none = shell();
  none.linked.close(Promise.resolve());
  await settle();
  assert.equal(none.groups.length, 0);
  assert.throws(() => none.linked.files.open("processes/order.bpmn"), /closed/);
});

test("close: a socket group whose teardown throws is reported, never thrown into the shell's cleanup", async () => {
  const errors = mock.method(console, "error", () => {});
  try {
    const sync = shell();
    sync.linked.files.open("processes/order.bpmn");
    sync.groups[0]!.failure = new Error("provider teardown failed");
    assert.doesNotThrow(() => sync.linked.close());
    assert.equal(sync.groups[0]!.destroyed, 1);

    const later = shell();
    later.linked.files.open("processes/order.bpmn");
    later.groups[0]!.failure = new Error("provider teardown failed");
    later.linked.close(Promise.resolve());
    await settle();
    assert.equal(later.groups[0]!.destroyed, 1);
    assert.equal(errors.mock.callCount(), 2);
  } finally {
    errors.mock.restore();
  }
});

test("the live editor hands its editor the linked files and closes them after the editor's destroy, waiting for its unmount", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/components/live-editor.tsx", import.meta.url)), "utf8");
  assert.match(source, /linkedFiles: linked\.files,/, "the mounted editor gets them");
  const cleanup = source.slice(source.indexOf("mounted?.destroy();"));
  const close = cleanup.indexOf("linked.close(");
  assert.ok(close > 0, "closed after the editor's destroy()");
  assert.ok(close < cleanup.indexOf("session.destroy();"), "in the same cleanup");
  // the mounted editor's unmount, or the one of an editor whose mount was still on its way
  assert.match(cleanup.slice(close), /^linked\.close\(\s*mounted\s*\?\s*mounted\.unmounted\s*:\s*late\?\.then\(/);
});

test("a linked file that moves tells the shell, whose model list then loads again", () => {
  const told: MovedNotice[] = [];
  const listeners: ((notice: MovedNotice) => void)[] = [];
  const linked = linkedFiles({
    listed: () => MODELS,
    room: (path) => `acme/models/${path}`,
    openGroup: () => ({
      open: () =>
        ({
          setUser: () => undefined,
          onMoved: (listener: (notice: MovedNotice) => void) => {
            listeners.push(listener);
            return () => undefined;
          },
          destroy: () => undefined,
        }) as unknown as LiveSession,
      destroy: () => undefined,
    }),
    user: USER,
    onMoved: (notice) => void told.push(notice),
  });
  linked.files.open("processes/order.bpmn");
  assert.equal(listeners.length, 1, "the session's notice is listened to");
  const notice: MovedNotice = {
    type: "bpmiq/moved",
    to: "processes/sales/order.bpmn",
    room: "acme/models/processes/sales/order.bpmn",
    by: "Ada",
  };
  listeners[0]?.(notice);
  assert.deepEqual(told, [notice]);
});
