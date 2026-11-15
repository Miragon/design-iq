/**
 * Entry of board-spike.html: the board of the URL's parameters (DESIGN.md section 6, samples.ts),
 * on the bench. Everything the board is made of comes from here: the sample board and its files,
 * all six strategies' surfaces, and the bench's own extras (the sample choice in the toolbar, the
 * Files panel, window.__boardSpike). A host brings its own parts (notations/board/editor.tsx).
 */
// first, before anything a strategy could patch: the browser's own geometry functions for the measurements
import "./native-geometry.ts";
import "./page-styles.ts";
import "@xyflow/react/dist/style.css";

import { lazy } from "react";
import { createRoot } from "react-dom/client";

import { Board } from "../notations/board/board.tsx";
import { createBoardLog, createBoardRuntime } from "../notations/board/board-context.tsx";
import { createBoardDoc, createBoardStore } from "../notations/board/board-doc.ts";
import { ToolbarLead } from "./bench/toolbar-lead.tsx";
import { createModelHub } from "./model-hub.ts";
import { BOARD_PATH, buildBoard, parseBoardParams, SAMPLE_FILES, sampleAssets } from "./samples.ts";
import { SURFACES } from "./strategies/index.ts";
import { captureErrors, installHooks } from "./test-hooks.ts";

const FilesPanel = lazy(() => import("./files-panel.tsx").then((module) => ({ default: module.FilesPanel })));

// outside React, once: the hub, the board store and what is armed outlive every render
const params = parseBoardParams(location.search);
const log = createBoardLog();
const seed = buildBoard(params);
const hub = createModelHub({ files: SAMPLE_FILES, assets: sampleAssets(), log: log.log });
const store = createBoardStore(createBoardDoc(seed.snapshot));
// the board is a file like the models: its at-rest text shows in the file list
hub.addSource(BOARD_PATH, "board", { text: store.text, subscribe: store.subscribe });
const runtime = createBoardRuntime(params, {
  store,
  hub,
  surfaces: SURFACES,
  strategies: seed.strategies,
  log,
  bench: { ToolbarLead, SidePanel: FilesPanel, install: installHooks },
  // What a host ships where every model node is an overlay node: the batteries then measure the
  // board's own key handling. Any other strategy keeps its armed editor inside the node, where a
  // focusable canvas around it would catch the focus (BoardParts.inputScope)
  inputScope: params.strategy === "overlay" && params.board !== "compare" ? "board" : "page",
  // the fit every measurement of the bench was taken with
  fitPadding: 0.08,
});
captureErrors(runtime.log);
// no StrictMode, like the product's entry: an engine is mounted once, and counters().mounts says so
createRoot(document.getElementById("root")!).render(<Board runtime={runtime} />);
