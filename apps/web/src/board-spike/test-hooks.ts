/**
 * window.__boardSpike: what the board page hands a script that drives it (BoardSpikeHooks in
 * shared.ts). Everything is answered from the board context and the DOM; nothing here knows an engine.
 */
import type { ReactFlowInstance } from "@xyflow/react";

import type { BoardContextValue } from "../notations/board/board-context.tsx";
import { notationOf } from "../notations/board/board-doc.ts";
import type { BoardFlowEdge, BoardFlowNode } from "../notations/board/board-flow.tsx";
import { nativeRect } from "./native-geometry.ts";
import { type BoardSpikeHooks, type FrameSample, HOOKS_KEY } from "./shared.ts";

/** how long arm() waits for a surface that never says it takes input, before it logs and goes on */
const INTERACTIVE_TIMEOUT_MS = 5000;
/** frames one startFrames() records at most: about five minutes at 60 Hz */
const FRAMES_AT_MOST = 20_000;

const frames = (count: number): Promise<void> =>
  new Promise((resolve) => {
    const step = (left: number): void => void (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });

const wrapperOf = (nodeId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);

/** page errors go into the log from the first line of the entry on, before anything renders */
export function captureErrors(log: (line: string) => void): void {
  window.addEventListener("error", (event) => log(`error: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    log(`unhandledrejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}

export function installHooks(
  board: BoardContextValue,
  flow: ReactFlowInstance<BoardFlowNode, BoardFlowEdge>,
): () => void {
  const modelNodes = () => board.store.getSnapshot().nodes.filter((node) => node.attrs.type === "model");
  /** the node whose frame shows as armed right now, as the DOM has it */
  const shownArmed = (): string | null =>
    document.querySelector('.board-node[data-armed="true"]')?.closest(".react-flow__node")?.getAttribute("data-id") ??
    null;

  /** in-page strategies: what the surface keeps of its engine (EngineRuntime in engines/use-engine.ts) */
  const editorOf = (nodeId: string): { zoom?: number; host?: HTMLElement } | undefined =>
    board.surface(nodeId)?.engine as { zoom?: number; host?: HTMLElement } | undefined;
  let recording: { frames: FrameSample[]; frame: number } | null = null;
  const sample = (): void => {
    if (!recording) return;
    const armed = board.armedId();
    const editor = armed === null ? undefined : editorOf(armed);
    recording.frames.push({
      t: performance.now(),
      ...flow.getViewport(),
      armed,
      shown: shownArmed(),
      moving: board.arming.state().moving,
      editorZoom: editor?.zoom ?? null,
      layout: editor?.host?.dataset.layout ?? null,
    });
    recording.frame = recording.frames.length < FRAMES_AT_MOST ? requestAnimationFrame(sample) : 0;
  };

  const hooks: BoardSpikeHooks = {
    get ready() {
      return (
        flow.viewportInitialized &&
        modelNodes().every((node) => board.mounted(node.id) !== undefined) &&
        // `&arm=` under a rule that moves the board is armed only once the board is measured
        !board.arming.state().urlPending
      );
    },
    nodes: () =>
      board.store.getSnapshot().nodes.map((node) => {
        const model = node.attrs.type === "model";
        const notation = model ? notationOf(node.attrs.file) : undefined;
        const frameName = board.surface(node.id)?.frameName;
        return {
          id: node.id,
          type: node.attrs.type,
          ...(notation ? { notation } : {}),
          ...(node.attrs.file !== undefined ? { file: node.attrs.file } : {}),
          ...(model ? { strategy: board.strategyOf(node.id) } : {}),
          armed: board.armedId() === node.id,
          mounted: board.mounted(node.id) === true,
          ...(frameName !== undefined ? { frameName } : {}),
        };
      }),
    viewport: () => flow.getViewport(),
    async setViewport(viewport) {
      // no duration: set at once. The surfaces hear of it synchronously (subscribeViewport); two
      // frames later every useBoardZoom consumer has rendered and painted too. Straight to React
      // Flow, past the arm rules: this is the zoom the board does not see coming (board-arming.ts)
      await flow.setViewport(viewport);
      await frames(2);
    },
    async arm(nodeId) {
      // through the arm rule: resolves when the board rests (the hook stands in for Edit and Done)
      await board.arm(nodeId, { source: "hook" });
      // null after an interrupted transition, whatever was asked for
      const wanted = board.armedId();
      // the flag reaches the node's frame through a React commit or two
      for (let waited = 0; waited < 60 && shownArmed() !== wanted; waited++) await frames(1);
      await frames(1);
      const surface = wanted === null ? undefined : board.surface(wanted);
      if (!surface) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        surface.whenInteractive(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            board.log(`${wanted}: armed, but its surface did not take input within ${INTERACTIVE_TIMEOUT_MS} ms`);
            resolve();
          }, INTERACTIVE_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    },
    armPolicy: (nodeId) => (board.isModel(nodeId) ? board.arming.policy(nodeId) : null),
    armState: () => board.arming.state(),
    lastTransition: () => board.arming.lastTransition(),
    transitions: () => board.arming.transitions(),
    async whenRest() {
      await board.arming.whenRest();
    },
    startFrames() {
      if (recording) cancelAnimationFrame(recording.frame);
      recording = { frames: [], frame: 0 };
      // the first sample now, inside the caller's task: the state before whatever comes next
      sample();
    },
    stopFrames() {
      const recorded = recording?.frames ?? [];
      if (recording) cancelAnimationFrame(recording.frame);
      recording = null;
      return recorded;
    },
    nodeBox(nodeId) {
      const wrapper = wrapperOf(nodeId);
      if (!wrapper) return null;
      // a measuring read: the browser's own function, whatever a strategy patched (native-geometry.ts)
      const { x, y, width, height } = nativeRect(wrapper);
      return { x, y, width, height };
    },
    probe: (nodeId) => board.surface(nodeId)?.probe ?? null,
    engine: (nodeId) => board.surface(nodeId)?.engine,
    fileText: (path) => board.hub.text(path),
    files: () => board.hub.files(),
    boardText: () => board.store.text(),
    counters: () => ({ ...board.counters, mounts: { ...board.counters.mounts }, arm: { ...board.counters.arm } }),
    log: () => [...board.lines],
  };
  Object.assign(window, { [HOOKS_KEY]: hooks });
  return () => {
    const page = window as unknown as Record<string, unknown>;
    if (page[HOOKS_KEY] === hooks) delete page[HOOKS_KEY];
  };
}
