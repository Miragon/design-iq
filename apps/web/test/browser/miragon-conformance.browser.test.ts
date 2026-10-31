/**
 * @miragon/modeler-api's conformance kit against the five Miragon renderers as designIQ mounts
 * them (issue 301): each spec's own factories from `load()` (`contractOptions` and what the spec
 * adds, such as the canvas's own undo keys), given the mount options of the SPA's editor (no
 * import fit of the renderer's own) and of the MCP-App widget (its chrome's insets as the free
 * area, no import fit either), checked by `assertContract`, in a host that carries the spec's
 * canvas class, with what a spec's `attached` adds there. The jsdom suite
 * (miragon-renderers.test.ts) cannot lay a canvas out; the kit needs the browser's layout for the
 * view state, the boxes and the fit.
 *
 * Both hosts pass `fitOnImport: false` and set the view after an import themselves: the widget
 * fits only a view nobody moved, the SPA only its first import. The kit's L5 cases expect a fitted
 * view after every import, so an import here first has to leave the view as it was (a renderer
 * that fits anyway, or a mount that lost the option, fails the case) and then ends with a fit
 * into the host's insets (miragonView). That fit stands in for the hosts' own view handling, which
 * a pass says nothing about. The free area is not observable here, as no kit case reads it:
 * miragon-renderers.test.ts checks that each renderer gets the widget's insets.
 *
 * The harnesses follow the renderers' own (packages/renderer/test/browser in
 * Miragon/modeler-suite), their fixtures copied from the releases designIQ pins, the gestures of
 * contract 1.6 (`startGesture`, `armTool`, `startPan`) included: real pointer events on the
 * canvas, at points in diagram coordinates, so they land on the same elements whatever view the
 * host's fit leaves. A skip or an advisory fails, as there.
 */
import { assertContract } from "@designiq/live-client/miragon-sync";
import type {
  CmContext,
  CmElementFactory,
  CmLabelEditing,
  CollaborativeContextMapsModeler,
} from "@miragon/context-maps-renderer";
import type {
  EventStormingElementFactory,
  EventStormingLabelEditing,
  EventStormingModeling,
} from "@miragon/event-storming-renderer";
import type { CollaborativeModeler, ImportResult } from "@miragon/modeler-api";
import {
  attachedHost,
  type ConformanceHarness,
  type GestureKind,
  type HeldGesture,
  type HeldPan,
  type InteractionState,
  registerConformance,
} from "@miragon/modeler-api/conformance";
import type {
  CollaborativeTeamTopologiesModeler,
  Modeler as TeamTopologiesModeler,
  TtElement,
  TtElementFactory,
  TtLabelEditing,
  TtModeling,
} from "@miragon/team-topologies-renderer";
import type {
  CollaborativeValueChainModeler,
  VcElementFactory,
  VcLabelEditingProvider,
} from "@miragon/value-chain-renderer";
import type {
  CollaborativeWardleyModeler,
  Modeler as WardleyModeler,
  WardleyElementFactory,
  WardleyLabelEditing,
} from "@miragon/wardley-renderer";
import type CommandStack from "diagram-js/lib/command/CommandStack";
import type Canvas from "diagram-js/lib/core/Canvas";
import type ElementRegistry from "diagram-js/lib/core/ElementRegistry";
import type Modeling from "diagram-js/lib/features/modeling/Modeling";
import type { Element as DiagramElement, Root, Shape } from "diagram-js/lib/model/Types";
import { afterEach, describe, test } from "vitest";

import type { Insets } from "../../src/mcp-app/core/engine.ts";
import { computeLayout } from "../../src/mcp-app/core/layout.ts";
import { miragonView } from "../../src/mcp-app/engines/miragon.ts";
import { paletteBottomIn, SPA_MOUNT, spaFitInsets } from "../../src/notations/miragon/editor.ts";
import { MIRAGON_RENDERERS } from "../../src/notations/miragon/index.ts";
import type { MiragonModeler, MiragonMountOptions, MiragonRendererSpec } from "../../src/notations/miragon/spec.ts";
import conferencePlanner from "./fixtures/context-map/conference-planner.cm?raw";
import conferencePlannerLoose from "./fixtures/context-map/conference-planner.loose.cm?raw";
import orderFulfilment from "./fixtures/context-map/order-fulfilment.cm?raw";
import orderFulfilmentForeign from "./fixtures/context-map/order-fulfilment.foreign.cm?raw";
import orderFulfilmentLoose from "./fixtures/context-map/order-fulfilment.loose.cm?raw";
import orderCheckoutForeign from "./fixtures/event-storming/order-checkout.foreign.storm?raw";
import orderCheckoutLoose from "./fixtures/event-storming/order-checkout.loose.storm?raw";
import orderCheckout from "./fixtures/event-storming/order-checkout.storm?raw";
import warehouseBigPictureLoose from "./fixtures/event-storming/warehouse-big-picture.loose.storm?raw";
import warehouseBigPicture from "./fixtures/event-storming/warehouse-big-picture.storm?raw";
import onlineShopForeign from "./fixtures/team-topology/online-shop.foreign.tt?raw";
import onlineShopLoose from "./fixtures/team-topology/online-shop.loose.tt?raw";
import onlineShop from "./fixtures/team-topology/online-shop.tt?raw";
import onlineShopV2 from "./fixtures/team-topology/online-shop.v2.tt?raw";
import rideHailing from "./fixtures/team-topology/ride-hailing.tt?raw";
import orderToCashForeign from "./fixtures/value-chain/order-to-cash.foreign.vc.json?raw";
import orderToCashLoose from "./fixtures/value-chain/order-to-cash.loose.vc.json?raw";
import orderToCash from "./fixtures/value-chain/order-to-cash.vc.json?raw";
import porter from "./fixtures/value-chain/porter.vc.json?raw";
import platformStrategy from "./fixtures/wardley/platform-strategy.wmap?raw";
import teaShopForeign from "./fixtures/wardley/tea-shop.foreign.wmap?raw";
import teaShopLoose from "./fixtures/wardley/tea-shop.loose.wmap?raw";
import teaShop from "./fixtures/wardley/tea-shop.wmap?raw";

type NotationHarness = Omit<ConformanceHarness, "create" | "createReadonly">;

interface Services {
  get<T>(name: string): T;
}

const HOST_WIDTH = 800;
const HOST_HEIGHT = 600;
const VIEW_STATE = { x: 120, y: 80, width: 640, height: 480 };
const TYPED = "typed, not committed";

const servicesOf = (modeler: CollaborativeModeler): Services =>
  (modeler as MiragonModeler).diagram as unknown as Services;

function elementOf(modeler: CollaborativeModeler, id: string): DiagramElement {
  const element = servicesOf(modeler).get<ElementRegistry>("elementRegistry").get(id);
  if (!element) throw new Error(`the imported document has no element ${id}`);
  return element as DiagramElement;
}

const rootOf = (modeler: CollaborativeModeler): Root =>
  servicesOf(modeler).get<Canvas>("canvas").getRootElement() as Root;

const containerOf = (modeler: CollaborativeModeler): HTMLElement =>
  servicesOf(modeler).get<Canvas>("canvas").getContainer();

const modelingOf = (modeler: CollaborativeModeler): Modeling => servicesOf(modeler).get<Modeling>("modeling");

const undoOnCommandStack = (modeler: CollaborativeModeler): void =>
  servicesOf(modeler).get<CommandStack>("commandStack").undo();

const redoOnCommandStack = (modeler: CollaborativeModeler): void =>
  servicesOf(modeler).get<CommandStack>("commandStack").redo();

// the label editors open one task after an import
const settleAfterLabelEditor = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** `text` with `fragment` replaced; a fixture that lost the fragment fails here, not in the kit */
function replaced(text: string, fragment: string, replacement: string): string {
  if (!text.includes(fragment)) throw new Error(`the fixture lost "${fragment}"`);
  return text.replace(fragment, replacement);
}

function pressEnter(field: HTMLElement, init: KeyboardEventInit = {}): void {
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
}

interface Point {
  x: number;
  y: number;
}

/** One step of the kit's pan, in screen pixels: past the 15 px drag threshold of diagram-js's MoveCanvas. */
const PAN_STEP = 40;

const canvasOf = (modeler: CollaborativeModeler): Canvas => servicesOf(modeler).get<Canvas>("canvas");

function canvasSvgOf(modeler: CollaborativeModeler): SVGSVGElement {
  const svg = containerOf(modeler).querySelector<SVGSVGElement>(":scope > svg");
  if (!svg) throw new Error("the canvas has no <svg>");
  return svg;
}

/** the client point of a point in diagram coordinates, under the view as it is now */
function clientAt(modeler: CollaborativeModeler, point: Point): Point {
  const canvas = canvasOf(modeler);
  const rect = canvas.getContainer().getBoundingClientRect();
  const viewbox = canvas.viewbox();
  return { x: rect.left + (point.x - viewbox.x) * viewbox.scale, y: rect.top + (point.y - viewbox.y) * viewbox.scale };
}

function diagramAt(modeler: CollaborativeModeler, client: Point): Point {
  const canvas = canvasOf(modeler);
  const rect = canvas.getContainer().getBoundingClientRect();
  const viewbox = canvas.viewbox();
  return {
    x: viewbox.x + (client.x - rect.left) / viewbox.scale,
    y: viewbox.y + (client.y - rect.top) / viewbox.scale,
  };
}

function centreOf(target: Element): Point {
  const rect = target.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function middleOf(modeler: CollaborativeModeler, id: string): Point {
  const shape = elementOf(modeler, id) as Shape;
  return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
}

const shifted = (point: Point, dx: number, dy: number): Point => ({ x: point.x + dx, y: point.y + dy });

function mouse(target: EventTarget, type: string, at: Point, init: MouseEventInit = {}): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: at.x, clientY: at.y, ...init }),
  );
}

function graphicsOf(modeler: CollaborativeModeler, id: string): SVGElement {
  const graphics = servicesOf(modeler).get<ElementRegistry>("elementRegistry").getGraphics(id);
  if (!graphics) throw new Error(`no graphics for ${id}`);
  return graphics;
}

const rootGraphicsOf = (modeler: CollaborativeModeler): SVGElement => graphicsOf(modeler, rootOf(modeler).id);

function paletteEntry(modeler: CollaborativeModeler, action: string): HTMLElement {
  const entry = containerOf(modeler).querySelector<HTMLElement>(`.djs-palette [data-action="${action}"]`);
  if (!entry) throw new Error(`the palette has no ${action} entry`);
  return entry;
}

/** a pointer click on a palette entry (`detail: 1`, unlike Enter or Space on it), at its centre */
function clickEntry(entry: HTMLElement): Point {
  const at = centreOf(entry);
  mouse(entry, "click", at, { detail: 1 });
  return at;
}

function dragEntry(entry: HTMLElement): Point {
  const at = centreOf(entry);
  entry.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
  return at;
}

/** the pointer enters the canvas: diagram-js takes a drag's drop target from the hover events */
function enterCanvas(modeler: CollaborativeModeler): void {
  canvasSvgOf(modeler).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

/** Escape where diagram-js's dragging hears it: a keyup on the document */
function escapeOnDocument(): void {
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }));
}

/** Escape as the keyboard sends it to the focused canvas */
function escapeOnCanvas(modeler: CollaborativeModeler): void {
  const svg = canvasSvgOf(modeler);
  for (const type of ["keydown", "keyup"]) {
    svg.dispatchEvent(new KeyboardEvent(type, { key: "Escape", bubbles: true, cancelable: true }));
  }
}

function holdPan(target: EventTarget, start: Point, step = PAN_STEP): HeldPan {
  let steps = 0;
  const pointer = (): Point => shifted(start, steps * step, 0);
  mouse(target, "mousedown", pointer());
  steps = 1;
  mouse(document, "mousemove", pointer());
  return {
    move() {
      steps += 1;
      mouse(document, "mousemove", pointer());
    },
    drop: () => mouse(document, "mouseup", pointer()),
  };
}

async function svgExportOf(modeler: CollaborativeModeler): Promise<string> {
  const diagram = (modeler as MiragonModeler).diagram as unknown as {
    saveSVG(): { svg: string } | Promise<{ svg: string }>;
  };
  return (await diagram.saveSVG()).svg;
}

function wardleyHarness(host: DesignIqHost): NotationHarness {
  const mapOf = (modeler: CollaborativeModeler): WardleyModeler =>
    (modeler as CollaborativeWardleyModeler).diagram as WardleyModeler;
  const labelEditing = (modeler: CollaborativeModeler): WardleyLabelEditing =>
    servicesOf(modeler).get<WardleyLabelEditing>("wardleyLabelEditing");
  const labelField = (modeler: CollaborativeModeler): HTMLInputElement | HTMLTextAreaElement => {
    const field = containerOf(modeler).querySelector<HTMLInputElement | HTMLTextAreaElement>(".wardley-label-input");
    if (!field) throw new Error("no label editor is open");
    return field;
  };
  // free plot of tea-shop, inside the view an import fits: where a create lands and a pan starts
  const freeSpot: Point = { x: 500, y: 330 };
  // Without a free area (the SPA's mount passes no insets) the map's pan constraint keeps the
  // content within 120 diagram units of the view's sides: past the SPA's fit of this host that
  // leaves about 52 px to pan, short of the two 40 px steps the pan case takes from the fit (its
  // first one, and one more from the view it restores). 20 px still passes MoveCanvas's threshold.
  // The widget's free area leaves room for the suite's step.
  const panStep = host.mount.insets ? PAN_STEP : 20;
  // a drop lands where it applies, so a create held over the palette is brought onto the plot first
  const startGesture = (modeler: CollaborativeModeler, kind: GestureKind): HeldGesture => {
    const svg = canvasSvgOf(modeler);
    const cancel = (): void => escapeOnCanvas(modeler);
    if (kind === "move") {
      const cup = modeler.elements?.list().find((element) => element.name === "Cup")?.id;
      if (!cup) throw new Error("the imported map has no component Cup to move");
      const pressed = clientAt(modeler, middleOf(modeler, cup));
      mouse(graphicsOf(modeler, cup), "mousedown", pressed);
      enterCanvas(modeler);
      const held = shifted(pressed, 30, 10);
      mouse(document, "mousemove", shifted(held, -15, 0));
      mouse(document, "mousemove", held);
      return { drop: () => mouse(svg, "mouseup", held), cancel };
    }
    const entry = clickEntry(paletteEntry(modeler, "create.component"));
    if (kind === "create") {
      enterCanvas(modeler);
      const held = clientAt(modeler, freeSpot);
      mouse(document, "mousemove", held);
      return { drop: () => mouse(svg, "mouseup", held), cancel };
    }
    mouse(document, "mousemove", shifted(entry, 4, 2));
    return {
      drop() {
        enterCanvas(modeler);
        const spot = clientAt(modeler, freeSpot);
        mouse(document, "mousemove", spot);
        mouse(svg, "mouseup", spot);
      },
      cancel,
    };
  };
  // each new component is named apart, so the collision case compares ids of different components
  let added = 0;
  return {
    canonicalTexts: [teaShop, platformStrategy],
    looseTexts: [teaShopLoose],
    // the DSL reads every text: a line it cannot read stays as it is, with a diagnostic
    invalidTexts: [],
    foreignTexts: [{ text: teaShopForeign, mustSurvive: ["x-vendor: keep-me", "owner team-tea"] }],
    probeTexts: [
      replaced(teaShop, "[0.43, 0.35]", "[0.43,"),
      replaced(teaShop, "Hot Water -> Kettle; limited by", "Hot Water -> Ket"),
      replaced(teaShop, "pipeline Kettle [0.3, 0.65]", "pipeline Kettle {"),
      replaced(teaShop, "evolve Kettle 0.62", "evolve Kettle 0.6e999"),
      "component Unclosed [0.5",
    ],
    viewState: VIEW_STATE,
    mutate(modeler) {
      added += 1;
      const component = servicesOf(modeler)
        .get<WardleyElementFactory>("wardleyElementFactory")
        .createNew("component", `Added Component ${added}`);
      modelingOf(modeler).createShape(component as unknown as Shape, { x: 400, y: 300 }, rootOf(modeler));
    },
    configMutations: [
      {
        name: "x-axis labels",
        run: (modeler) => mapOf(modeler).setEvolutionLabels(["Idea", "Craft", "Product", "Utility"]),
      },
      { name: "title", run: (modeler) => mapOf(modeler).setTitle("Renamed map") },
      {
        name: "map size",
        run: async (modeler) => {
          await mapOf(modeler).setMapSize(1500, 950);
        },
      },
    ],
    undo: undoOnCommandStack,
    redo: redoOnCommandStack,
    moveElement(modeler) {
      const id = modeler.elements?.list().find((element) => element.name === "Kettle")?.id;
      if (!id) throw new Error("the imported map has no component Kettle to move");
      modelingOf(modeler).moveElements([elementOf(modeler, id) as Shape], { x: 60, y: 40 });
      return id;
    },
    settle: settleAfterLabelEditor,
    openInteraction(modeler) {
      labelEditing(modeler).activate(
        elementOf(modeler, "cmp_kettle") as unknown as Parameters<WardleyLabelEditing["activate"]>[0],
      );
      labelField(modeler).value = TYPED;
    },
    interactionState(modeler) {
      const edit = labelEditing(modeler).getActiveEdit();
      return edit ? { elementId: edit.elementId, text: edit.value } : undefined;
    },
    commitInteraction: (modeler) => pressEnter(labelField(modeler)),
    startGesture,
    armTool(modeler) {
      const entry = clickEntry(paletteEntry(modeler, "lasso-tool"));
      enterCanvas(modeler);
      mouse(document, "mousemove", shifted(entry, 40, 120));
      mouse(document, "mousemove", shifted(entry, 60, 160));
    },
    startPan(modeler) {
      canvasSvgOf(modeler).focus();
      return holdPan(rootGraphicsOf(modeler), clientAt(modeler, freeSpot), panStep);
    },
    exportImage: svgExportOf,
  };
}

function eventStormingHarness(): NotationHarness {
  const labelEditing = (modeler: CollaborativeModeler): EventStormingLabelEditing =>
    servicesOf(modeler).get<EventStormingLabelEditing>("eventStormingLabelEditing");
  const labelField = (modeler: CollaborativeModeler): HTMLTextAreaElement => {
    const field = containerOf(modeler).querySelector<HTMLTextAreaElement>("textarea.event-storming-label-textarea");
    if (!field) throw new Error("no label editor is open");
    return field;
  };
  const stickyToEdit = (modeler: CollaborativeModeler): DiagramElement => elementOf(modeler, "event_order_placed");
  // free board of order-checkout, above the closed line: where a create lands and a pan starts
  const freeSpot: Point = { x: 300, y: 100 };
  // hover first: diagram-js takes a drag's drop target from the hover events
  const hoverAt = (modeler: CollaborativeModeler, point: Point): void => {
    const svg = canvasSvgOf(modeler);
    mouse(svg, "mouseover", clientAt(modeler, point));
    mouse(svg, "mousemove", clientAt(modeler, point));
  };
  // a drop lands where it applies, so a create held over the palette is brought onto the board first
  const startGesture = (modeler: CollaborativeModeler, kind: GestureKind): HeldGesture => {
    const svg = canvasSvgOf(modeler);
    if (kind === "move") {
      const sticky = stickyToEdit(modeler);
      const start = middleOf(modeler, sticky.id);
      const end = shifted(start, 60, 40);
      mouse(graphicsOf(modeler, sticky.id), "mousedown", clientAt(modeler, start));
      hoverAt(modeler, shifted(start, 30, 20));
      hoverAt(modeler, end);
      return { drop: () => mouse(svg, "mouseup", clientAt(modeler, end)), cancel: escapeOnDocument };
    }
    mouse(paletteEntry(modeler, "create.event"), "click", clientAt(modeler, freeSpot), { detail: 1 });
    if (kind === "create") {
      hoverAt(modeler, shifted(freeSpot, -40, -20));
      hoverAt(modeler, freeSpot);
    }
    return {
      drop() {
        hoverAt(modeler, freeSpot);
        mouse(svg, "mousedown", clientAt(modeler, freeSpot));
        mouse(svg, "mouseup", clientAt(modeler, freeSpot));
      },
      cancel: escapeOnDocument,
    };
  };
  let added = 0;
  return {
    canonicalTexts: [orderCheckout, warehouseBigPicture],
    looseTexts: [orderCheckoutLoose, warehouseBigPictureLoose],
    // the DSL reads every text: a line it cannot read stays as it is
    invalidTexts: [],
    foreignTexts: [{ text: orderCheckoutForeign, mustSurvive: ["x-vendor: keep-me", "owner team-checkout"] }],
    probeTexts: [
      replaced(orderCheckout, "[40, 200]", "[40,"),
      replaced(orderCheckout, "[660, 320]", "[660,"),
      replaced(orderCheckout, "Order Placed [660, 320]", "Order Placed [660, 320] (id event_"),
      replaced(orderCheckout, "(size 240x120)", "(size 240x"),
      "event Unclosed [10",
    ],
    viewState: VIEW_STATE,
    mutate(modeler) {
      added += 1;
      const sticky = servicesOf(modeler)
        .get<EventStormingElementFactory>("eventStormingElementFactory")
        .createNew("event", `Domain Event ${added}`);
      modelingOf(modeler).createShape(sticky as unknown as Shape, { x: 1240, y: 700 }, rootOf(modeler));
    },
    configMutations: [
      {
        name: "level",
        run(modeler) {
          const modeling = servicesOf(modeler).get<EventStormingModeling>("eventStormingModeling");
          modeling.setLevel(modeling.getLevel() === "design" ? "process" : "design");
        },
      },
    ],
    undo: undoOnCommandStack,
    redo: redoOnCommandStack,
    moveElement(modeler) {
      const sticky = stickyToEdit(modeler);
      modelingOf(modeler).moveElements([sticky as Shape], { x: 160, y: 120 });
      return sticky.id;
    },
    settle: settleAfterLabelEditor,
    openInteraction(modeler) {
      labelEditing(modeler).activate(
        stickyToEdit(modeler) as unknown as Parameters<EventStormingLabelEditing["activate"]>[0],
      );
      labelField(modeler).value = TYPED;
    },
    interactionState(modeler) {
      const edit = labelEditing(modeler).openEdit();
      return edit ? { elementId: edit.elementId, text: edit.value } : undefined;
    },
    // Cmd/Ctrl+Enter saves a sticky; a plain Enter breaks its line
    commitInteraction: (modeler) => pressEnter(labelField(modeler), { ctrlKey: true }),
    startGesture,
    armTool(modeler) {
      mouse(paletteEntry(modeler, "lasso-tool"), "click", clientAt(modeler, freeSpot), { detail: 1 });
      hoverAt(modeler, shifted(freeSpot, 40, 20));
    },
    // diagram-js's MoveCanvas takes a press only while the canvas has the focus
    startPan(modeler) {
      canvasOf(modeler).focus();
      return holdPan(canvasSvgOf(modeler), clientAt(modeler, freeSpot));
    },
    exportImage: svgExportOf,
  };
}

function teamTopologyHarness(): NotationHarness {
  const diagramOf = (modeler: CollaborativeModeler): TeamTopologiesModeler =>
    (modeler as CollaborativeTeamTopologiesModeler).diagram as TeamTopologiesModeler;
  const labelEditing = (modeler: CollaborativeModeler): TtLabelEditing =>
    servicesOf(modeler).get<TtLabelEditing>("ttLabelEditing");
  const labelField = (modeler: CollaborativeModeler): HTMLTextAreaElement => {
    const field = containerOf(modeler).querySelector<HTMLTextAreaElement>("textarea.tt-label-editor");
    if (!field) throw new Error("no label editor is open");
    return field;
  };
  const withoutSizeOf = (interactionId: string): string => {
    const sizeOfInteraction = new RegExp(`("id": "${interactionId}",[\\s\\S]*?),\\n\\s*"size": \\{[^}]*\\}`);
    if (!sizeOfInteraction.test(onlineShop)) throw new Error(`the fixture lost "${interactionId}"`);
    return onlineShop.replace(sizeOfInteraction, "$1");
  };
  // free canvas of the online-shop sample, right of the flow: where a create lands
  const freeSpot: Point = { x: 1120, y: 120 };
  const moveTo = (modeler: CollaborativeModeler, point: Point): void =>
    mouse(document, "mousemove", clientAt(modeler, point));
  const releaseAt = (modeler: CollaborativeModeler, point: Point): void =>
    mouse(canvasSvgOf(modeler), "mouseup", clientAt(modeler, point));
  // a drop lands where it applies, so a create held over the palette is brought onto free canvas first
  const startGesture = (modeler: CollaborativeModeler, kind: GestureKind): HeldGesture => {
    if (kind === "move") {
      const start = middleOf(modeler, "team_checkout");
      const end = shifted(start, 60, 30);
      mouse(graphicsOf(modeler, "team_checkout"), "mousedown", clientAt(modeler, start));
      enterCanvas(modeler);
      moveTo(modeler, shifted(start, 20, 10));
      moveTo(modeler, end);
      return { drop: () => releaseAt(modeler, end), cancel: escapeOnDocument };
    }
    if (kind === "create") {
      clickEntry(paletteEntry(modeler, "team.platform"));
      enterCanvas(modeler);
      moveTo(modeler, shifted(freeSpot, -40, 0));
      moveTo(modeler, freeSpot);
      return { drop: () => releaseAt(modeler, freeSpot), cancel: escapeOnDocument };
    }
    const entry = dragEntry(paletteEntry(modeler, "team.stream-aligned"));
    mouse(document, "mousemove", shifted(entry, 12, 8));
    return {
      drop() {
        enterCanvas(modeler);
        moveTo(modeler, freeSpot);
        releaseAt(modeler, freeSpot);
      },
      cancel: escapeOnDocument,
    };
  };
  let teams = 0;
  let titles = 0;
  return {
    canonicalTexts: [onlineShop, rideHailing],
    looseTexts: [onlineShopLoose, onlineShopV2],
    invalidTexts: [
      replaced(onlineShop, '"type": "platform",', '"type": "platfo'),
      replaced(onlineShop, '"mode": "collaboration"', '"mode": "handover"'),
      replaced(onlineShop, '"id": "team_fraud"', '"id": "team_checkout"'),
      replaced(onlineShop, '"id": "flow_main"', '"id": "tt-root"'),
      replaced(onlineShop, '"id": "flow_main"', '"id": "assoc_ann_fraud_handover"'),
      replaced(onlineShop, '"id": "flow_main"', '"id": "constructor"'),
      withoutSizeOf("int_platform_fulfilment"),
    ],
    foreignTexts: [
      {
        text: onlineShopForeign,
        mustSurvive: [
          '"x-vendor": "keep-me"',
          '"x-owner": "team-checkout"',
          '"x-source": {\n        "page": 12,\n        "tool": "wiki"\n      }',
        ],
      },
    ],
    probeTexts: [
      replaced(onlineShop, '"x": 220,\n        "y": 276', '"x": 220,\n        "y": '),
      replaced(onlineShop, '"width": 600,', '"width": 6'),
      replaced(onlineShop, '"attachedTo": "int_checkout_fraud"', '"attachedTo": "int_check'),
      replaced(onlineShop, '"title": "Online shop team topology",', '"title": "Online shop'),
      "{",
    ],
    viewState: VIEW_STATE,
    mutate(modeler) {
      teams += 1;
      const team = servicesOf(modeler)
        .get<TtElementFactory>("ttElementFactory")
        .createNewTeam("stream-aligned", `Payments ${teams}`);
      modelingOf(modeler).createShape(team as unknown as Shape, { x: 1400, y: 700 }, rootOf(modeler));
    },
    configMutations: [
      {
        name: "title",
        run(modeler) {
          titles += 1;
          servicesOf(modeler).get<TtModeling>("ttModeling").setTitle(`Renamed topology ${titles}`);
        },
      },
    ],
    undo: (modeler) => diagramOf(modeler).undo(),
    redo: (modeler) => diagramOf(modeler).redo(),
    moveElement(modeler) {
      const team = elementOf(modeler, "team_checkout");
      modelingOf(modeler).moveElements([team as Shape], { x: 60, y: 40 });
      return team.id;
    },
    settle: settleAfterLabelEditor,
    openInteraction(modeler) {
      labelEditing(modeler).activate(elementOf(modeler, "team_checkout") as unknown as TtElement);
      labelField(modeler).value = TYPED;
    },
    interactionState(modeler) {
      const edit = labelEditing(modeler).openEdit();
      return edit ? { elementId: edit.elementId, text: edit.value } : undefined;
    },
    commitInteraction: (modeler) => pressEnter(labelField(modeler)),
    startGesture,
    armTool(modeler) {
      clickEntry(paletteEntry(modeler, "lasso-tool"));
      enterCanvas(modeler);
      moveTo(modeler, { x: 600, y: 60 });
      moveTo(modeler, { x: 640, y: 90 });
    },
    // diagram-js's MoveCanvas takes a press only while the canvas has the focus
    startPan(modeler) {
      canvasOf(modeler).focus();
      return holdPan(rootGraphicsOf(modeler), centreOf(containerOf(modeler)));
    },
    exportImage: svgExportOf,
  };
}

function contextMapHarness(): NotationHarness {
  const mapOf = (modeler: CollaborativeModeler): CollaborativeContextMapsModeler["diagram"] =>
    (modeler as CollaborativeContextMapsModeler).diagram;
  const labelEditing = (modeler: CollaborativeModeler): CmLabelEditing =>
    servicesOf(modeler).get<CmLabelEditing>("cmLabelEditing");
  const labelField = (modeler: CollaborativeModeler): HTMLElement => {
    const field = containerOf(modeler).querySelector<HTMLElement>(".djs-direct-editing-content");
    if (!field) throw new Error("no label editor is open");
    return field;
  };
  // free canvas of the conference planner, away from every context and relationship
  const freeSpot: Point = { x: 150, y: 600 };
  const hoverCanvasAt = (modeler: CollaborativeModeler, at: Point): void => {
    mouse(document, "mousemove", at);
    mouse(canvasSvgOf(modeler), "mouseover", at);
    mouse(document, "mousemove", at);
  };
  // a drop lands where it applies, so a create held over the palette is brought onto free canvas first
  const startGesture = (modeler: CollaborativeModeler, kind: GestureKind): HeldGesture => {
    if (kind === "move") {
      const start = clientAt(modeler, middleOf(modeler, "ctx_cfp"));
      const hit = graphicsOf(modeler, "ctx_cfp").querySelector(".djs-hit");
      if (!hit) throw new Error("ctx_cfp has no hit area");
      mouse(hit, "mousedown", start);
      mouse(document, "mousemove", shifted(start, 20, 10));
      const held = shifted(start, 40, 20);
      hoverCanvasAt(modeler, held);
      return {
        drop() {
          mouse(document, "mousemove", shifted(held, 10, 0));
          mouse(document, "mouseup", shifted(held, 10, 0));
        },
        cancel: escapeOnDocument,
      };
    }
    if (kind === "create") {
      dragEntry(paletteEntry(modeler, "context.core"));
      const held = clientAt(modeler, freeSpot);
      hoverCanvasAt(modeler, held);
      return {
        drop() {
          mouse(document, "mousemove", shifted(held, 5, 0));
          mouse(document, "mouseup", shifted(held, 5, 0));
        },
        cancel: escapeOnDocument,
      };
    }
    const onPalette = clickEntry(paletteEntry(modeler, "context.supporting"));
    mouse(document, "mousemove", shifted(onPalette, 3, 2));
    return {
      drop() {
        const target = clientAt(modeler, freeSpot);
        hoverCanvasAt(modeler, target);
        mouse(canvasSvgOf(modeler), "mousedown", target);
        mouse(document, "mouseup", target);
      },
      cancel: escapeOnDocument,
    };
  };
  let contexts = 0;
  let titles = 0;
  return {
    canonicalTexts: [conferencePlanner, orderFulfilment],
    looseTexts: [conferencePlannerLoose, orderFulfilmentLoose],
    invalidTexts: [
      "{",
      "not a context map",
      "[]",
      '{ "version": 2, "title": "From the future", "contexts": [], "relationships": [] }',
      replaced(conferencePlanner, '"id": "ctx_cfp"', '"id": "ctx_auth"'),
      replaced(conferencePlanner, '"id": "ctx_cfp"', '"id": "cm-root"'),
      replaced(conferencePlanner, '"id": "ctx_cfp"', '"id": "constructor"'),
      replaced(conferencePlanner, '"x": 340', '"x": 1e38'),
      replaced(conferencePlanner, '"pattern": "shared-kernel"', '"pattern": "shared'),
    ],
    probeTexts: [
      replaced(conferencePlanner, '"x": 340,', '"x": 34'),
      replaced(conferencePlanner, '"label": "identity"', '"label": "iden'),
      replaced(conferencePlanner, '"subdomainType": "core"', '"subdomainType": "co"'),
      replaced(conferencePlanner, '"to": "ctx_cfp"', '"to": "ctx_'),
    ],
    foreignTexts: [
      {
        text: orderFulfilmentForeign,
        mustSurvive: ['"x-vendor": {', '"x-repository": "git@example.com:shop/ordering.git"', '"x-weight": 3'],
      },
    ],
    viewState: VIEW_STATE,
    mutate(modeler) {
      contexts += 1;
      const context = servicesOf(modeler)
        .get<CmElementFactory>("cmElementFactory")
        .createNewContext("core", `New context ${contexts}`);
      modelingOf(modeler).createShape(context as unknown as Shape, { x: 1200, y: 700 }, rootOf(modeler));
    },
    configMutations: [
      {
        name: "title",
        run(modeler) {
          titles += 1;
          mapOf(modeler).setMeta({ title: `Renamed map ${titles}` });
        },
      },
    ],
    undo: undoOnCommandStack,
    redo: redoOnCommandStack,
    moveElement(modeler) {
      modelingOf(modeler).moveElements([elementOf(modeler, "ctx_cfp") as Shape], { x: 160, y: 96 });
      return "ctx_cfp";
    },
    settle: settleAfterLabelEditor,
    openInteraction(modeler) {
      labelEditing(modeler).activate(elementOf(modeler, "ctx_cfp") as unknown as CmContext);
      labelField(modeler).innerText = TYPED;
    },
    interactionState(modeler) {
      const edit = labelEditing(modeler).openEdit();
      return edit ? { elementId: edit.elementId, text: edit.text } : undefined;
    },
    commitInteraction: (modeler) => pressEnter(labelField(modeler), { keyCode: 13 }),
    startGesture,
    armTool(modeler) {
      clickEntry(paletteEntry(modeler, "lasso-tool"));
      hoverCanvasAt(modeler, clientAt(modeler, freeSpot));
    },
    // diagram-js's MoveCanvas takes a press only while the canvas has the focus
    startPan(modeler) {
      canvasOf(modeler).focus();
      return holdPan(rootGraphicsOf(modeler), centreOf(containerOf(modeler)));
    },
    exportImage: svgExportOf,
  };
}

type Json = Record<string, unknown>;

function valueChainHarness(): NotationHarness {
  /** the same document as hand-written JSON: tabs, CRLF, keys and elements in reverse order */
  const rewritten = (canonical: string): string => {
    const reverse = (value: unknown): unknown => {
      if (Array.isArray(value)) return [...value].reverse().map(reverse);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, entry]) => [key, reverse(entry)]),
        );
      }
      return value;
    };
    return JSON.stringify(reverse(JSON.parse(canonical)), null, "\t").replace(/\n/g, "\r\n");
  };
  const withDocument = (canonical: string, change: (document: Json) => void): string => {
    const document = JSON.parse(canonical) as Json;
    change(document);
    return JSON.stringify(document, null, 2);
  };
  const elementsOf = (document: Json): Json[] => document["elements"] as Json[];
  const connectionsOf = (document: Json): Json[] => document["connections"] as Json[];
  /** the element `from` under the id `to`, its connections following it: the id is the only defect */
  const withElementRenamed = (canonical: string, from: string, to: string): string =>
    withDocument(canonical, (document) => {
      for (const element of elementsOf(document)) if (element["id"] === from) element["id"] = to;
      for (const connection of connectionsOf(document)) {
        for (const end of ["source", "target"]) if (connection[end] === from) connection[end] = to;
      }
    });
  const labelField = (modeler: CollaborativeModeler): HTMLElement => {
    const field = containerOf(modeler).querySelector<HTMLElement>(".djs-direct-editing-content");
    if (!field) throw new Error("no label editor is open");
    return field;
  };
  // free canvas of the Porter example, below Marketing: where a create lands and a pan starts
  const freeSpot: Point = { x: 800, y: 380 };
  // a release without a point is where the pointer last was
  const pointerOn = (modeler: CollaborativeModeler) => {
    let last: Point = { x: 0, y: 0 };
    const fire = (target: EventTarget, type: string, point: Point, init?: MouseEventInit): void => {
      last = point;
      mouse(target, type, clientAt(modeler, point), init);
    };
    const moveTo = (point: Point): void => fire(document, "mousemove", point);
    return {
      press: (target: EventTarget, point: Point) => fire(target, "mousedown", point),
      moveTo,
      hover(point: Point) {
        fire(canvasSvgOf(modeler), "mouseover", point);
        moveTo(point);
      },
      release: (point: Point = last) => fire(document, "mouseup", point),
      pick(action: string): Point {
        const entry = paletteEntry(modeler, action);
        const at = diagramAt(modeler, centreOf(entry));
        fire(entry, "click", at, { detail: 1 });
        return at;
      },
    };
  };
  // a drop lands where it applies, so a create held over the palette is brought onto the canvas first
  const startGesture = (modeler: CollaborativeModeler, kind: GestureKind): HeldGesture => {
    const pointer = pointerOn(modeler);
    if (kind === "move") {
      const [first] = (modeler as CollaborativeValueChainModeler).elements.list();
      if (!first) throw new Error("the diagram has no element to move");
      const start = middleOf(modeler, first.id);
      pointer.press(graphicsOf(modeler, first.id), start);
      pointer.moveTo(shifted(start, 20, 0));
      pointer.moveTo(shifted(start, 40, 0));
      return { drop: () => pointer.release(), cancel: escapeOnDocument };
    }
    const entry = pointer.pick("create.step");
    if (kind === "create") pointer.hover(freeSpot);
    else pointer.moveTo(shifted(entry, 0, 8));
    return {
      drop() {
        pointer.hover(freeSpot);
        pointer.release(freeSpot);
      },
      cancel: escapeOnDocument,
    };
  };
  let steps = 0;
  return {
    canonicalTexts: [porter, orderToCash],
    looseTexts: [orderToCashLoose, rewritten(porter)],
    invalidTexts: [
      // a sequence between two org units breaks the relation matrix
      withDocument(orderToCash, (document) => {
        connectionsOf(document).push({
          id: "seq-org",
          connectionType: "sequence",
          source: "org-sales",
          target: "org-finance",
          waypoints: [
            { x: 120, y: 330 },
            { x: 615, y: 230 },
          ],
        });
      }),
      // a document of a newer tool
      withDocument(orderToCash, (document) => {
        document["schemaVersion"] = 99;
      }),
      // two elements with one id
      withDocument(orderToCash, (document) => {
        elementsOf(document).push({ ...elementsOf(document)[0]!, name: "Twin" });
      }),
      // the id of the canvas root
      withElementRenamed(orderToCash, "org-finance", "vc-root"),
      // an id the editor's element registry already resolves
      withElementRenamed(orderToCash, "org-sales", "constructor"),
    ],
    probeTexts: [
      '{\n  "schemaVersion": 1,\n  "meta": { "name": "Half',
      replaced(orderToCash, '"name": "Delivery"', '"name": "Deliv'),
      replaced(orderToCash, '"height": 60,\n        "width": 160,\n        "x": 420,', ""),
      "{}",
      "null",
    ],
    foreignTexts: [
      {
        text: orderToCashForeign,
        mustSurvive: [
          '"x-vendor": "keep-me-document"',
          '"x-vendor": "keep-me-meta"',
          '"x-vendor": "keep-me-element"',
          '"note": "keep-me-connection"',
          '"weight": 1.23456789',
        ],
      },
    ],
    viewState: VIEW_STATE,
    // no document setting is editable on the canvas: the name lives in the text only
    configMutations: [],
    mutate(modeler) {
      steps += 1;
      const step = servicesOf(modeler).get<VcElementFactory>("vcElementFactory").createNewStep(`Step ${steps}`);
      modelingOf(modeler).createShape(step as unknown as Shape, { x: 100 + 40 * steps, y: 520 }, rootOf(modeler));
    },
    undo: undoOnCommandStack,
    redo: redoOnCommandStack,
    moveElement(modeler) {
      const [first] = (modeler as CollaborativeValueChainModeler).elements.list();
      if (!first) throw new Error("the diagram has no element to move");
      modelingOf(modeler).moveShape(elementOf(modeler, first.id) as Shape, { x: 40, y: 24 });
      return first.id;
    },
    openInteraction(modeler) {
      servicesOf(modeler)
        .get<{ activate(element: DiagramElement): boolean }>("directEditing")
        .activate(elementOf(modeler, "step-operations"));
      labelField(modeler).innerText = TYPED;
    },
    interactionState(modeler): InteractionState | undefined {
      const open = servicesOf(modeler).get<VcLabelEditingProvider>("vcLabelEditingProvider").openEdit();
      return open ? { elementId: open.element.id, text: open.text } : undefined;
    },
    commitInteraction: (modeler) => pressEnter(labelField(modeler), { keyCode: 13 }),
    startGesture,
    armTool: (modeler) => void pointerOn(modeler).pick("lasso-tool"),
    startPan(modeler) {
      const pointer = pointerOn(modeler);
      pointer.pick("hand-tool");
      pointer.hover(freeSpot);
      return holdPan(canvasSvgOf(modeler), clientAt(modeler, freeSpot));
    },
    exportImage: svgExportOf,
  };
}

const HARNESSES: Readonly<Record<string, (host: DesignIqHost) => NotationHarness>> = {
  wardley: wardleyHarness,
  "event-storming": eventStormingHarness,
  "team-topology": teamTopologyHarness,
  "context-map": contextMapHarness,
  "value-chain": valueChainHarness,
};

interface DesignIqHost {
  name: string;
  mount: MiragonMountOptions;
  /** where the host's fit after an import puts the content */
  fitInsets(container: HTMLElement): Insets;
}

const WIDGET_FIT_INSETS: Insets = computeLayout({
  W: HOST_WIDTH,
  H: HOST_HEIGHT,
  displayMode: "inline",
  kind: "miragon",
  steps: { tl: [0], tr: [0] },
  palette: { w: 0, h: 0 },
  panelOpen: false,
}).fitInsets;

const HOSTS: readonly DesignIqHost[] = [
  {
    name: "the SPA's editor",
    mount: SPA_MOUNT,
    fitInsets: (container) => spaFitInsets({ paletteBottom: paletteBottomIn(container), coveredRight: 0 }),
  },
  {
    name: "the MCP-App widget",
    mount: { insets: () => WIDGET_FIT_INSETS },
    fitInsets: () => WIDGET_FIT_INSETS,
  },
];

const hostWrappers: HTMLElement[] = [];
const mountsWhoseImportMovedTheView = new Set<string>();

afterEach(() => {
  for (const wrapper of hostWrappers.splice(0)) wrapper.remove();
  const moved = [...mountsWhoseImportMovedTheView];
  mountsWhoseImportMovedTheView.clear();
  if (moved.length > 0) {
    throw new Error(`an import moved the view itself, so fitOnImport: false did not reach ${moved.join(", ")}`);
  }
});

async function mountAsDesignIq(
  spec: MiragonRendererSpec,
  host: DesignIqHost,
  readonly: boolean,
): Promise<CollaborativeModeler> {
  const renderer = await spec.load();
  const container = attachedHost(HOST_WIDTH, HOST_HEIGHT);
  if (container.parentElement) hostWrappers.push(container.parentElement);
  container.classList.add(spec.canvasClassName);
  const modeler = readonly ? renderer.createViewer(host.mount) : renderer.create(host.mount);
  assertContract(modeler, spec.contractNotation);
  modeler.attachTo(container);
  const detach = renderer.attached?.(modeler, container);
  const view = miragonView(modeler);
  const mountName = `${spec.pkg}${readonly ? " (viewer)" : ""} as ${host.name} mounts it`;
  // the kit destroys the modeler from its listeners, an import's included (contract 1.6): what a
  // host does after an import then has no modeler left to read or fit
  let destroyed = false;
  const waitingImports = new Set<{ view: string }>();
  const importLeavingTheView = async (text: string): Promise<ImportResult> => {
    // an import after destroy() is the renderer's alone to answer
    if (destroyed) return modeler.importText(text);
    const waiting = { view: JSON.stringify(modeler.getViewState()) };
    waitingImports.add(waiting);
    try {
      return await modeler.importText(text);
    } finally {
      waitingImports.delete(waiting);
      if (!destroyed && JSON.stringify(modeler.getViewState()) !== waiting.view) {
        mountsWhoseImportMovedTheView.add(mountName);
      }
    }
  };
  return new Proxy(modeler, {
    get(target, property) {
      if (property === "importText") {
        return async (text: string) => {
          const result = await importLeavingTheView(text);
          if (destroyed) return result;
          view.fit(host.fitInsets(container), false);
          // an import called while this one waited may settle after this fit: the view it leaves
          // is the one the host set, not the one it was called on
          for (const waiting of waitingImports) waiting.view = JSON.stringify(modeler.getViewState());
          return result;
        };
      }
      if (property === "destroy") {
        // the host's part once, and the renderer's every time: a second destroy() is the kit's to check
        return () => {
          if (!destroyed) {
            destroyed = true;
            view.destroy();
            detach?.();
          }
          target.destroy();
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const failOnSkipOrAdvisory = {
  onSkip(caseName: string, reason: string): never {
    throw new Error(`conformance case "${caseName}" skipped: ${reason}`);
  },
  onAdvisory(caseName: string, advice: string): never {
    throw new Error(`conformance case "${caseName}" advises: ${advice}`);
  },
};

for (const spec of MIRAGON_RENDERERS) {
  const harness = HARNESSES[spec.id];
  for (const host of HOSTS) {
    describe(`${spec.pkg} as ${host.name} mounts it`, () => {
      if (!harness) {
        test("has a conformance harness", () => {
          throw new Error(`no conformance harness for the Miragon renderer spec '${spec.id}'`);
        });
        return;
      }
      registerConformance(
        {
          ...harness(host),
          create: () => mountAsDesignIq(spec, host, false),
          createReadonly: () => mountAsDesignIq(spec, host, true),
        },
        test,
        failOnSkipOrAdvisory,
      );
    });
  }
}
