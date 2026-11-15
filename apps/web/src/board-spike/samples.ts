/**
 * The spike's "repository": one sample file per notation under the path it would have in a
 * content repo, one image, and the boards of DESIGN.md section 6. The model files are the example
 * content repo's own and the canonical fixtures of the Miragon conformance suite.
 */
import { fractionalIndexBetween } from "@designiq/notations/codecs";
import { CD, FONT_SANS } from "@designiq/ui-kit/lib/tokens";

import creditLimitCheck from "../../../../process-documentation/processes/credit-limit-check.dmn?raw";
import orderToCash from "../../../../process-documentation/processes/order-to-cash.bpmn?raw";
import orderToCashStorm from "../../../../process-documentation/processes/order-to-cash.storm?raw";
import invoiceHandling from "../../../../process-documentation/processes/subprocesses/invoice-handling.bpmn?raw";
import orderFulfilment from "../../test/browser/fixtures/context-map/order-fulfilment.cm?raw";
import onlineShop from "../../test/browser/fixtures/team-topology/online-shop.tt?raw";
import valueChain from "../../test/browser/fixtures/value-chain/order-to-cash.vc.json?raw";
import teaShop from "../../test/browser/fixtures/wardley/tea-shop.wmap?raw";
import { parseArmParams } from "../notations/board/arm-rules.ts";
import type { BoardSnapshot, EdgeAttrs, ElementAttrs, NodeAttrs } from "../notations/board/board-doc.ts";
import type { BoardOptions } from "../notations/board/types.ts";
import { MODEL_NOTATIONS, type ModelNotation, type Mount, MOUNTS, STRATEGIES, type Strategy } from "./shared.ts";

export const BOARD_PATH = "boards/workshop.board";
export const IMAGE_PATH = "assets/sketch.svg";

const ORDER = "processes/order-to-cash.bpmn";
const INVOICE = "processes/subprocesses/invoice-handling.bpmn";
const CREDIT = "processes/credit-limit-check.dmn";
const STORM = "processes/order-to-cash.storm";
const WARDLEY = "processes/tea-shop.wmap";

/** repo-relative path -> text. The extension is the notation's registered one (@designiq/notations) */
export const SAMPLE_FILES: Readonly<Record<string, string>> = {
  [ORDER]: orderToCash,
  [INVOICE]: invoiceHandling,
  [CREDIT]: creditLimitCheck,
  [STORM]: orderToCashStorm,
  [WARDLEY]: teaShop,
  "processes/online-shop.tt": onlineShop,
  // the fixture is named .cm; a content repo's Context Map is a .cm.json
  "processes/order-fulfilment.cm.json": orderFulfilment,
  "processes/order-to-cash.vc.json": valueChain,
};

/** the file a board shows for a notation (matrix, stress) */
export const SAMPLE_OF: Readonly<Record<ModelNotation, string>> = {
  bpmn: ORDER,
  dmn: CREDIT,
  wardley: WARDLEY,
  "team-topology": "processes/online-shop.tt",
  "event-storming": STORM,
  "context-map": "processes/order-fulfilment.cm.json",
  "value-chain": "processes/order-to-cash.vc.json",
};

/** an image has no CSS variables: the CI colours as values, from the kit's mirror */
const SKETCH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 208" font-family='${FONT_SANS}' font-size="13">
  <rect width="320" height="208" fill="${CD.grau}"/>
  <g fill="${CD.weiss}" stroke="${CD.schwarz}" stroke-width="1.5">
    <rect x="24" y="36" width="92" height="48" rx="8"/>
    <rect x="204" y="36" width="92" height="48" rx="8"/>
    <rect x="114" y="132" width="92" height="48" rx="8"/>
  </g>
  <g fill="none" stroke="${CD.blau}" stroke-width="1.5">
    <path d="M116 60h88M250 84c0 40-20 60-44 68M70 84c0 40 20 60 44 68"/>
  </g>
  <g fill="${CD.schwarz}" text-anchor="middle">
    <text x="70" y="65">Order</text><text x="250" y="65">Invoice</text><text x="160" y="161">Payment</text>
  </g>
</svg>
`;

export const sampleAssets = (): Record<string, Blob> => ({
  [IMAGE_PATH]: new Blob([SKETCH], { type: "image/svg+xml" }),
});

export const BOARDS = ["demo", "compare", "matrix", "stress"] as const;
export type BoardName = (typeof BOARDS)[number];

/**
 * The URL parameters of board-spike.html (DESIGN.md section 6). With them the arm rules
 * (ArmParams in arm-rules.ts), for every strategy: `&armzoom=off|min1|exact1`,
 * `&armedzoom=free|disarm|lock`, `&armreturn=stay|back`, `&armmotion=<ms>`. A rule that is null
 * takes the default of each node's strategy (overlay: exact1, disarm, stay; any other: off, free, stay).
 */
export interface BoardParams extends BoardOptions {
  board: BoardName;
  /** what an overlay node mounts: the spike's reduced editor (default) or the product's own (`&mount=product`) */
  mount: Mount;
  /** matrix */
  notations: ModelNotation[];
  /** stress */
  notation: ModelNotation;
  count: number;
}

/** the bench always sets a board up with its own parameters: what the board hands back as its options is that object */
export const benchParams = (options: BoardOptions): BoardParams => options as BoardParams;

export function parseBoardParams(search: string): BoardParams {
  const params = new URLSearchParams(search);
  const pick = <T extends string>(all: readonly T[], value: string | null, fallback: T): T =>
    all.find((one) => one === value) ?? fallback;
  const number = (name: string): number | undefined => {
    const value = params.get(name);
    return value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
  };
  const listed = (params.get("notations") ?? "").split(",");
  const notations = MODEL_NOTATIONS.filter((id) => listed.includes(id));
  const [zoom, x, y] = [number("zoom"), number("x"), number("y")];
  return {
    board: pick(BOARDS, params.get("board"), "demo"),
    strategy: pick(STRATEGIES, params.get("strategy"), "overlay"),
    mount: pick(MOUNTS, params.get("mount"), "spike"),
    notations: notations.length > 0 ? notations : [...MODEL_NOTATIONS],
    notation: pick(MODEL_NOTATIONS, params.get("notation"), "bpmn"),
    count: Math.max(1, Math.min(200, Math.round(number("count") ?? 12))),
    viewport:
      zoom === undefined && x === undefined && y === undefined ? null : { x: x ?? 0, y: y ?? 0, zoom: zoom ?? 1 },
    arm: params.get("arm"),
    ...parseArmParams(params),
  };
}

export interface BoardSeed {
  snapshot: BoardSnapshot;
  /** node id -> its strategy, where the board fixes it; every other model node takes BoardParams.strategy */
  strategies: Readonly<Record<string, Strategy>>;
}

/** collects a board's elements; every node gets the next z key, so a later node paints over an earlier one */
function builder(title: string) {
  const elements: Record<string, ElementAttrs> = {};
  let z: string | undefined;
  return {
    node(id: string, attrs: Omit<NodeAttrs, "kind" | "z">): void {
      elements[id] = { kind: "node", ...attrs, z: (z = fractionalIndexBetween(z)) };
    },
    arrow(id: string, attrs: Omit<EdgeAttrs, "kind">): void {
      elements[id] = { kind: "edge", ...attrs };
    },
    snapshot: (): BoardSnapshot => ({ elements, meta: { title, version: 1 } }),
  };
}

/** `count` boxes of one size in rows of `columns`, `gap` apart */
const grid = (index: number, columns: number, width: number, height: number, gap: number) => ({
  x: (index % columns) * (width + gap),
  y: Math.floor(index / columns) * (height + gap),
  width,
  height,
});

/** the workshop board a person looks at */
function demo(): BoardSeed {
  const board = builder("Order to cash workshop");
  // first, so behind everything: array order is paint order
  board.node("d-group", { type: "group", text: "Order to cash", x: 960, y: 0, width: 1640, height: 1240 });
  board.node("d-order", { type: "model", file: ORDER, parent: "d-group", x: 40, y: 60, width: 940, height: 540 });
  board.node("d-credit", { type: "model", file: CREDIT, parent: "d-group", x: 1040, y: 60, width: 560, height: 440 });
  board.node("d-invoice", { type: "model", file: INVOICE, parent: "d-group", x: 40, y: 680, width: 940, height: 520 });
  board.node("d-note-1", {
    type: "text",
    parent: "d-group",
    x: 1040,
    y: 580,
    width: 400,
    height: 220,
    text: "## Open questions\n\n- Who approves a credit limit above **50 000**?\n- Is a partial delivery invoiced on its own?\n\nSee the `credit-limit-check` decision.",
  });
  board.node("d-storm", { type: "model", file: STORM, x: 0, y: 60, width: 860, height: 540 });
  board.node("d-wardley", { type: "model", file: WARDLEY, x: 0, y: 680, width: 860, height: 560 });
  board.node("d-note-2", {
    type: "text",
    x: 0,
    y: 1320,
    width: 400,
    height: 180,
    text: "# Workshop board\n\nEvery model here is a file of the repository. The board stores where it sits, never what is in it.",
  });
  board.node("d-image", { type: "image", file: IMAGE_PATH, x: 460, y: 1320, width: 320, height: 240 });
  board.arrow("d-arrow-1", {
    source: "d-note-1",
    target: "d-credit",
    sourceHandle: "top",
    targetHandle: "bottom",
    label: "settle the thresholds",
  });
  board.arrow("d-arrow-2", {
    source: "d-storm",
    target: "d-order",
    sourceHandle: "right",
    targetHandle: "left",
    label: "became the process",
  });
  board.arrow("d-arrow-3", {
    source: "d-image",
    target: "d-wardley",
    sourceHandle: "top",
    targetHandle: "bottom",
    label: "whiteboard photo",
  });
  return { snapshot: board.snapshot(), strategies: {} };
}

/** ONE BPMN file in six nodes, one per strategy, in two rows of three: an edit in one shows in the other five */
function compare(): BoardSeed {
  const board = builder("One file, six strategies");
  const strategies: Record<string, Strategy> = {};
  STRATEGIES.forEach((strategy, index) => {
    board.node(`c-${strategy}`, { type: "model", file: INVOICE, ...grid(index, 3, 800, 520, 120) });
    strategies[`c-${strategy}`] = strategy;
  });
  return { snapshot: board.snapshot(), strategies };
}

/** one node per notation, all in one strategy: the battery's board */
function matrix(notations: readonly ModelNotation[]): BoardSeed {
  const board = builder("Every notation");
  notations.forEach((notation, index) => {
    // wider than 760: four renderers switch to their narrow chrome below that (engines.md 1.0)
    board.node(`m-${notation}`, { type: "model", file: SAMPLE_OF[notation], ...grid(index, 3, 800, 540, 160) });
  });
  return { snapshot: board.snapshot(), strategies: {} };
}

/** `count` nodes of one file, for cost measurements */
function stress(notation: ModelNotation, count: number): BoardSeed {
  const board = builder(`${count} nodes`);
  const columns = Math.ceil(Math.sqrt(count));
  for (let index = 0; index < count; index++) {
    board.node(`s-${index}`, { type: "model", file: SAMPLE_OF[notation], ...grid(index, columns, 640, 420, 80) });
  }
  return { snapshot: board.snapshot(), strategies: {} };
}

export function buildBoard(params: BoardParams): BoardSeed {
  switch (params.board) {
    case "compare":
      return compare();
    case "matrix":
      return matrix(params.notations);
    case "stress":
      return stress(params.notation, params.count);
    default:
      return demo();
  }
}
