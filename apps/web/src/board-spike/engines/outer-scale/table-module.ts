/**
 * The outer-scale module for dmn-js's decision table (table-js: an HTML table drawn by Inferno
 * components, its own injector, no diagram-js canvas). A time-boxed attempt, layer `table`.
 *
 * table-js keeps its pointer math in components, not in services. Two things are in reach of a
 * module of the table's injector, and only these two are repaired:
 * - the `contextMenu` service's public `open(position, context)`: the position arrives in client px;
 * - the `components` registry: the provider of a cell's inner components hands out the class of the
 *   column border handle, which is swapped for a subclass.
 * Out of reach: dmn-js-shared `InputSelect` (the hit policy and type dropdowns), the simple mode
 * button and the context menu's own clamping. They are components that other components import
 * directly; no service and no registry entry leads to them.
 */
import type { ModuleDeclaration } from "didi";

import { outerScale } from "./geometry.ts";
import type { Layer } from "./layers.ts";

interface RendererLike {
  getContainer(): HTMLElement;
}
interface InjectorLike {
  get(name: string, strict?: boolean): unknown;
}
/** table-js ContextMenu.js: `x`, `y` and the optional size of what the menu is opened for, in client px */
interface MenuPosition {
  x: number;
  y: number;
  width?: number;
  height?: number;
}
interface ContextMenuLike {
  open?(position: MenuPosition | undefined, context?: unknown): void;
}
/** an Inferno component class, as the registry hands it out */
type ComponentClass = (new (props: unknown, context: unknown) => object) & { prototype: object };
interface ComponentsLike {
  getComponent(type: string, context?: unknown): ComponentClass | undefined;
  getComponents(type: string, context?: unknown): ComponentClass[];
}
/** dmn-js-decision-table ResizeColumn.js, as far as the subclass touches it */
interface ResizeColumnLike {
  props: { minWidth?: number };
  handleMouseDown(event: MouseEvent): void;
  saveWidth(width: number): void;
}

/** the smallest column dmn-js lets a border drag make (ResizeColumn.js) */
const MIN_COLUMN_WIDTH = 150;

/** ResizeColumn.js is the one cell component with this method on its prototype */
const isResizeColumn = (component: ComponentClass): boolean =>
  typeof component === "function" && !!component.prototype && "isLastInputOrOutput" in component.prototype;

/**
 * ResizeColumn.js with its border drag in container px. The original's private `startResize` adds
 * the pointer's client travel to the header cell's client width and writes the sum as CSS px into
 * the cell and, on release, as `width` into the model. This is a corrected copy of that helper
 * (25 lines): both terms are divided by the outer scale.
 */
function scaledResizeColumn(original: ComponentClass, container: () => HTMLElement): ComponentClass {
  return class ScaledResizeColumn extends original {
    constructor(props: unknown, context: unknown) {
      super(props, context);
      const self = this as unknown as ResizeColumnLike;
      self.handleMouseDown = (event: MouseEvent): void => {
        const cell = (event.target as Element | null)?.closest("th");
        if (!cell) return;
        event.preventDefault();
        const scale = (): number => outerScale(container());
        const initialWidth = cell.getBoundingClientRect().width / scale();
        const initialX = event.clientX;
        const minWidth = self.props.minWidth ?? MIN_COLUMN_WIDTH;
        const widthAt = (clientX: number): number => Math.max(initialWidth + (clientX - initialX) / scale(), minWidth);
        let frame = 0;
        const onMove = (move: MouseEvent): void => {
          move.preventDefault();
          const width = widthAt(move.clientX);
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            cell.style.width = `${width}px`;
          });
        };
        const onUp = (up: MouseEvent): void => {
          up.preventDefault();
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          self.saveWidth(widthAt(up.clientX));
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      };
    }
  };
}

class OuterScaleTable {
  static $inject = ["injector", "components", "renderer", "outerScaleLayers"];
  readonly layers: readonly Layer[];

  constructor(injector: InjectorLike, components: ComponentsLike, renderer: RendererLike, layers: readonly Layer[]) {
    this.layers = layers;
    if (!layers.includes("table")) return;
    const container = (): HTMLElement => renderer.getContainer();

    // the context menu: its component subtracts the container's client origin from the position and
    // writes the difference as container px. Handed the position where it would lie without the
    // outer scale, that difference is right
    const contextMenu = injector.get("contextMenu", false) as ContextMenuLike | null;
    const open = contextMenu?.open;
    if (contextMenu && typeof open === "function") {
      contextMenu.open = function (this: ContextMenuLike, position, context): void {
        if (!position) return open.call(this, position, context);
        const origin = container().getBoundingClientRect();
        const scale = outerScale(container());
        open.call(
          this,
          {
            ...position,
            x: origin.left + (position.x - origin.left) / scale,
            y: origin.top + (position.y - origin.top) / scale,
            ...(position.width !== undefined ? { width: position.width / scale } : {}),
            ...(position.height !== undefined ? { height: position.height / scale } : {}),
          },
          context,
        );
      };
    }

    // the column border handle: every class the registry hands out passes through here once
    const swapped = new Map<ComponentClass, ComponentClass>();
    const swap = (component: ComponentClass): ComponentClass => {
      if (!isResizeColumn(component)) return component;
      let scaled = swapped.get(component);
      if (!scaled) swapped.set(component, (scaled = scaledResizeColumn(component, container)));
      return scaled;
    };
    const { getComponent, getComponents } = components;
    components.getComponent = function (this: ComponentsLike, type, context) {
      const component = getComponent.call(this, type, context);
      return component && swap(component);
    };
    components.getComponents = function (this: ComponentsLike, type, context) {
      return getComponents.call(this, type, context).map(swap);
    };
  }
}

/** the module for the decision table's injector (MountOptions.tableModules) */
export function outerScaleTableModule(layers: readonly Layer[]): ModuleDeclaration {
  return {
    __init__: ["outerScaleTable"],
    outerScaleTable: ["type", OuterScaleTable],
    outerScaleLayers: ["value", layers],
  };
}
