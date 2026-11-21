/**
 * Integration test, runs INSIDE a real VS Code instance (@vscode/test-electron).
 * Exercises the M0 checklist from apps/live-host/README.md programmatically:
 *   1. open designiq:/…/order-to-cash.bpmn as text — content must equal the working tree
 *   2. remote guest edit → the open (non-dirty) document must update
 *   3. local edit + save → the remote guest must receive it
 *   4. if the Miragon BPMN Modeler is installed: open the SAME virtual doc with the
 *      custom editor (openWith) and assert the custom-editor tab is live
 *   5. a board (a structured room) opens read-only as its canonical text, follows
 *      a guest's element edit, refuses a write and leaves the room's Y.Text empty
 *
 * Server contract (multi-repo): HTTP + ws share ONE port (8301), room names are
 * repo-qualified (<owner>/<repo>/<path>). Needs the Live Host running with
 * LIVE_AUTH=none.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { CONTENT_KEY, ELEMENTS_KEY } from "@designiq/contracts/live";
import type { Me, ModelInfo } from "@designiq/contracts/live-host";
import { readSnapshot } from "@designiq/live-client/structured";
import { docCodecFor } from "@designiq/notations/codecs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as vscode from "vscode";
import WebSocket from "ws";
import type * as Y from "yjs";

import { hostJson } from "../host-api.ts";
import { modelItems } from "../model-picker.ts";
import { SCHEME } from "../scheme.ts";

const HOST_REPO = process.env.GITHUB_REPO ?? "Miragon/design-iq";
const FILE = "process-documentation/processes/order-to-cash.bpmn";
/** room name on the Live Host = <owner>/<repo>/<repo-relative-path> */
const DOC = `${HOST_REPO}/${FILE}`;
/** where that file lives on disk (the host serves the checkout in place);
 *  set by runTest.mts (repo-relative default) or overridden via the environment */
const CONTENT_ROOT = process.env.LIVE_HOST_CONTENT_DIR;
if (!CONTENT_ROOT)
  throw new Error("LIVE_HOST_CONTENT_DIR must point at the content-repo checkout the Live Host serves");
const MIRAGON = "miragon-gmbh.vs-code-bpmn-modeler";
/** step 5's board: the example content has none (a board names models by
 *  repo-relative path, which differs in the starter mirror), so the step
 *  writes this one and removes it afterwards */
const BOARD = "process-documentation/processes/vscode-e2e.board";
const results: string[] = [];
const pass = (m: string) => results.push(`PASS  ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

async function until(what: string, pred: () => boolean, ms = 8000): Promise<number> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return Date.now() - start;
}

export async function run(): Promise<void> {
  try {
    // headless guest, connected to the same live host
    const socket = new HocuspocusProviderWebsocket({
      url: "ws://localhost:8301",
      WebSocketPolyfill: WebSocket as never,
    });
    const guest = new HocuspocusProvider({ websocketProvider: socket, name: DOC, token: "e2e-guest" });
    guest.attach();
    await new Promise<void>((res, rej) => {
      guest.on("synced", () => res());
      setTimeout(() => rej(new Error("guest sync timeout")), 8000);
    });
    const ytext = guest.document.getText(CONTENT_KEY);

    // 0 — the picker's data path: the host lists the model we are about to open
    // (GET /models through the extension's own client — the host runs
    // LIVE_AUTH=none, so no credential is needed)
    try {
      const models = await hostJson<ModelInfo[]>(`http://localhost:8301/api/repos/${HOST_REPO}/models`);
      const item = modelItems(models).find((i) => i.value.path === FILE);
      if (item) pass(`picker: the host lists the model (${item.label} — ${item.description})`);
      else fail(`picker: ${FILE} not among the host's ${models.length} models`);
    } catch (err) {
      fail(`picker: model listing failed — ${(err as Error).message}`);
    }

    // 1 — open the live document as text
    const uri = vscode.Uri.parse(`${SCHEME}:/${DOC}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    const disk = readFileSync(`${CONTENT_ROOT}/${FILE}`, "utf8");
    if (doc.getText() === disk) pass("virtual document content equals working tree");
    else fail(`content mismatch: doc ${doc.getText().length} chars vs disk ${disk.length}`);

    // 1b — presence: the extension announced its identity in the room (on a
    // LIVE_AUTH=none host the local principal /api/me reports; a signed-in
    // person shows up under their own name)
    const expected = await hostJson<Me>("http://localhost:8301/api/me")
      .then((m) => m.user.name || m.user.login)
      .catch(() => "anonymous");
    const roster = () =>
      [...(guest.awareness?.getStates().values() ?? [])].map((s) => (s as { user?: { name?: string } }).user?.name);
    try {
      await until("VS Code presence in the room", () => roster().includes(expected), 4000);
      pass(`presence: the VS Code client shows up in the roster as ${expected}`);
    } catch {
      fail(`presence: VS Code missing from the roster (${JSON.stringify(roster())})`);
    }

    // 2 — inbound: remote edit reaches the open document
    const M1 = `<!-- vscode-e2e-in-${Date.now()} -->`;
    ytext.insert(ytext.length, `\n${M1}`);
    let autoReverted = true;
    try {
      const t = await until("remote edit visible in open document", () => doc.getText().includes(M1), 6000);
      pass(`remote edit auto-applied to open document after ${t}ms`);
    } catch {
      autoReverted = false;
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await until("remote edit after manual revert", () => doc.getText().includes(M1), 4000);
      pass("remote edit visible after explicit revert (auto-revert did NOT fire — M1 finding)");
    }

    // 3 — outbound: local edit + save reaches the guest
    const M2 = `<!-- vscode-e2e-out-${Date.now()} -->`;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(doc.lineCount, 0), `${M2}\n`);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    const tOut = await until("guest receives local edit", () => ytext.toString().includes(M2), 6000);
    pass(`local edit+save reached the remote guest after ${tOut}ms`);

    // 3b — the live binding: an UNSAVED local edit reaches the guest, a remote
    // edit reaches the document while it is being edited (the spike only
    // followed the room while the document was clean), and the document
    // settles clean — a live document has no unsaved state
    const M4 = `<!-- vscode-e2e-live-out-${Date.now()} -->`;
    const liveEdit = new vscode.WorkspaceEdit();
    liveEdit.insert(uri, new vscode.Position(doc.lineCount, 0), `${M4}\n`);
    await vscode.workspace.applyEdit(liveEdit);
    try {
      const t = await until("unsaved local edit reaches the guest", () => ytext.toString().includes(M4), 4000);
      pass(`live binding: unsaved local edit reached the guest after ${t}ms`);
    } catch {
      fail("live binding: unsaved local edit did not reach the guest");
    }
    const M5 = `<!-- vscode-e2e-live-in-${Date.now()} -->`;
    ytext.insert(ytext.length, `${M5}\n`);
    try {
      const t = await until("remote edit into the edited document", () => doc.getText().includes(M5), 4000);
      pass(`live binding: remote edit applied to the edited document after ${t}ms`);
    } catch {
      fail("live binding: remote edit did not reach the edited document");
    }
    try {
      await until("document settles clean", () => !doc.isDirty, 3000);
      pass("live binding: the document settles clean after both edits");
    } catch {
      fail("live binding: the document stayed dirty");
    }
    for (const m of [M4, M5]) {
      const s = ytext.toString();
      const i = s.indexOf(`${m}\n`);
      if (i >= 0) ytext.delete(i, m.length + 1);
    }
    await until("live markers gone from the document", () => !doc.getText().includes("vscode-e2e-live"), 4000);

    // 4 — the Miragon custom editor on the SAME virtual document
    const miragon = vscode.extensions.getExtension(MIRAGON);
    if (miragon) {
      await vscode.commands.executeCommand("vscode.openWith", uri, "bpmn-modeler.bpmn");
      await new Promise((r) => setTimeout(r, 4000)); // webview boot
      const tab = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "bpmn-modeler.bpmn");
      if (tab) pass(`Miragon BPMN Modeler opened the ${SCHEME}:// document (custom-editor tab active)`);
      else fail("no custom-editor tab for bpmn-modeler.bpmn found");
      // remote edit while the custom editor is open — document must keep syncing
      const M3 = `<!-- vscode-e2e-custom-${Date.now()} -->`;
      ytext.insert(ytext.length, `\n${M3}`);
      try {
        await until("remote edit while custom editor open", () => doc.getText().includes(M3), 6000);
        pass("remote edit propagated while the custom editor is open");
      } catch {
        results.push(
          "WARN  remote edit did not reach the document while custom editor open (custom editors keep non-dirty docs from auto-revert? M1 finding)",
        );
      }
      const s3 = ytext.toString();
      ytext.delete(s3.indexOf(`\n${M3}`), M3.length + 1);
    } else {
      results.push(`WARN  ${MIRAGON} not installed in test instance — custom-editor check skipped`);
    }

    // cleanup: remove markers via the guest, save nothing locally
    let s = ytext.toString();
    ytext.delete(s.indexOf(`\n${M1}`), M1.length + 1);
    s = ytext.toString();
    const i2 = s.indexOf(`${M2}\n`);
    if (i2 >= 0) ytext.delete(i2, M2.length + 1);
    await new Promise((r) => setTimeout(r, 3000)); // let write-through settle
    if (!readFileSync(`${CONTENT_ROOT}/${FILE}`, "utf8").includes("vscode-e2e")) pass("cleanup: working tree clean");
    else fail("cleanup: markers left on disk");
    if (!autoReverted) results.push("NOTE  auto-revert path needed manual revert");

    await boardStep();
  } catch (err) {
    fail(`unexpected: ${(err as Error).message}`);
  }

  console.log("\n=== VS Code E2E ===");
  for (const r of results) console.log(r);
  if (results.some((r) => r.startsWith("FAIL"))) throw new Error("VS Code E2E failed");
}

/** 5 — a structured room has no Y.Text: VS Code shows the board read-only as
 *  its canonical text, re-reads it after a guest's element edit, refuses a
 *  write, and nothing lands in the room's CONTENT_KEY */
async function boardStep(): Promise<void> {
  const codec = docCodecFor("board");
  if (!codec) {
    fail("board: no codec for the board notation");
    return;
  }
  const disk = `${CONTENT_ROOT}/${BOARD}`;
  const text = codec.encode({
    elements: {
      n_note: { kind: "node", type: "text", text: "vscode-e2e", x: 0, y: 0, width: 240, height: 160, z: "a" },
    },
    meta: { title: "VS Code e2e" },
  });
  writeFileSync(disk, text);
  const socket = new HocuspocusProviderWebsocket({ url: "ws://localhost:8301", WebSocketPolyfill: WebSocket as never });
  const guest = new HocuspocusProvider({
    websocketProvider: socket,
    name: `${HOST_REPO}/${BOARD}`,
    token: "e2e-guest",
  });
  try {
    guest.attach();
    await new Promise<void>((res, rej) => {
      guest.on("synced", () => res());
      setTimeout(() => rej(new Error("board guest sync timeout")), 8000);
    });
    const uri = vscode.Uri.parse(`${SCHEME}:/${HOST_REPO}/${BOARD}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    if (doc.getText() === text) pass("board: the document is the board's canonical text");
    else fail(`board: content mismatch, doc ${doc.getText().length} chars vs file ${text.length}`);

    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.permissions === vscode.FilePermission.Readonly) pass("board: the file system serves it read-only");
    else fail("board: the file system serves it writable");

    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${text}{"id":"n_typed"}\n`));
      fail("board: a write was accepted");
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === "NoPermissions")
        pass(`board: a write is refused (${err.message})`);
      else fail(`board: a write failed otherwise, ${(err as Error).message}`);
    }

    // a guest's canvas edit: one attribute of one element
    const note = guest.document.getMap(ELEMENTS_KEY).get("n_note") as Y.Map<unknown> | undefined;
    if (!note) {
      fail("board: the guest does not see the board's note");
      return;
    }
    note.set("text", "vscode-e2e moved");
    try {
      const t = await until(
        "the board's element edit in the open document",
        () => doc.getText().includes("moved"),
        6000,
      );
      pass(`board: a guest's element edit reached the read-only document after ${t}ms`);
    } catch {
      fail("board: a guest's element edit did not reach the document");
    }
    if (doc.getText() === codec.encode(readSnapshot(guest.document)))
      pass("board: the document stays the canonical text after the edit");
    else fail("board: the document is not the canonical text after the edit");
    if (guest.document.getText(CONTENT_KEY).length === 0) pass("board: nothing landed in the room's Y.Text");
    else fail("board: the room's Y.Text holds text");

    // the room keeps its edited lineage in live.db: back to the file's text, so
    // the next run opens the same board
    note.set("text", "vscode-e2e");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await new Promise((r) => setTimeout(r, 3000)); // let write-through settle before the file goes
  } finally {
    guest.destroy();
    socket.destroy();
    if (existsSync(disk)) unlinkSync(disk);
  }
}
