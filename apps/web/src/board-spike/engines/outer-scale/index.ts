/**
 * The outer-scale module (strategy `plugin`): ONE didi module, added to every editor, that makes
 * the engine right under an ancestor's CSS scale. The engine's host stays in the board's node,
 * scaled by the board like in `naive`; nothing is counter-scaled, moved or framed.
 *
 * The outer scale `s` is the net scale of the canvas container, client rect width over
 * `offsetWidth`. The module measures it itself at every use (geometry.ts), nothing is passed in, so
 * a board zoom under a running gesture is seen by the next event and no view is applied again.
 *
 * Layers (`&plugin=<comma list>`, layers.ts; all but `dragsvc` and `own` by default), the site
 * each repairs and how. Mechanisms: (a) public event or public API, (b) a named service replaced
 * through didi by a subclass, (c) a private member set on the instance, (d) a corrected copy of
 * engine code, (e) not reachable from a module. "facade": the subclass runs the engine's unchanged
 * constructor with a canvas whose one method answers for s (geometry.ts canvasFacade), because
 * the pointer math sits in a closure of that constructor. Paths are under diagram-js 15.28.1
 * `lib/` unless another package is named. No prototype is patched: every repair lives in the
 * injector or on the service objects of the one editor that carries the module.
 *
 * | Layer     | Site                                                           | Mech. | How, and the private names it leans on                                    |
 * | --------- | -------------------------------------------------------------- | ----- | ------------------------------------------------------------------------- |
 * | `drag`    | features/dragging/Dragging.js:159 `toLocalPoint` (closure):    | (a)   | listeners before all others on `drag.init` and `drag.move` recompute x,   |
 * |           | x, y, dx, dy of every drag (move, create, connect, resize,     |       | y, dx, dy from the pointer event; `dragging.context()` (public, "for      |
 * |           | lasso, space, hand, bendpoint, segment, global connect)        |       | introspection") gives `globalStart`, `localStart`, `displacement`,        |
 * |           |                                                                |       | `payload` (Dragging.js:528), which are repaired too                       |
 * | `dragsvc` | the same site, the other way (off by default)                  | (b)   | `dragging` = Dragging on a facade whose `viewbox().scale` is times s;     |
 * |           |                                                                |       | leans on `canvas.viewbox()` and `canvas._container` being all it reads    |
 * | `pan`     | navigation/movecanvas/MoveCanvas.js:63 `handleMove` (closure): | (b)   | `moveCanvas` = MoveCanvas on a facade whose `scroll()` divides by s       |
 * |           | pointer px handed to `canvas.scroll()`                         |       |                                                                           |
 * | `wheel`   | navigation/zoomscroll/ZoomScroll.js:121 `_handleWheel`: the    | (b)   | `zoomScroll` = subclass overriding the public `zoom(delta, position)` and |
 * |           | zoom pivot (:163) and the scroll distance (:178) in client px  |       | `scroll(delta)`; leans on `_handleWheel` being their only client-px caller |
 * | `pad`     | features/context-pad/ContextPad.js:588 `_getPosition`: client  | (c)   | own `_getTargetBounds` (:687) on the instance, which wraps the class's    |
 * |           | rect difference written as container px                        |       | (Wardley subclasses ContextPad and overrides exactly that method)         |
 * | `popup`   | features/popup-menu/PopupMenu.js:372 `_ensureVisible`: client  | (c)   | own `_ensureVisible` on the instance: its result converted into the px of |
 * |           | px into a `position: fixed` box under a transformed ancestor   |       | the fixed box's containing block, the popup's width pinned                |
 * | `tip`     | features/hover-tooltip/HoverTooltip.js:107 `_render` with      | (a)   | the public `hoverTooltip.add(config)` wrapped on the instance: every      |
 * |           | features/palette/PaletteTooltip.js:58: the same, for a tooltip |       | source's `getPosition` answers in the containing block's px               |
 * | `bend`    | features/bendpoints/BendpointUtil.js:37 `toCanvasCoordinates`, | (b)   | `bendpoints`, `connectionSegmentMove` = the two on a facade whose         |
 * |           | called in closures of Bendpoints.js:124, :345 and              |       | `viewbox().scale` is times s                                              |
 * |           | ConnectionSegmentMove.js:125                                   |       |                                                                           |
 * | `edit`    | diagram-js-direct-editing 3.6.0 lib/DirectEditing.js:165       | (a)   | on the public `directEditing.activate`: own `getBoundingClientRect` on    |
 * |           | `complete` (client size `!==` container size, client rect as   | + (c) | the editor's one text box element (`directEditing.$textbox`), answering   |
 * |           | new bounds) and lib/TextBox.js:353 `autoResize`                |       | in container px; `_active.context.bounds` for "unchanged within 0.05 px"  |
 * | `table`   | dmn-js-decision-table 17.13.0 lib/features/column-resize/      | (d)   | table-module.ts: the class swapped where the `components` registry hands  |
 * |           | components/ResizeColumn.js `startResize` (module-private)      |       | it out; a corrected copy of the 25-line helper (`handleMouseDown`,        |
 * |           |                                                                |       | `saveWidth`, `props.minWidth`, found by `isLastInputOrOutput`)            |
 * | `table`   | table-js 9.4.0 lib/features/context-menu: `open(position)`     | (a)   | the public `contextMenu.open` wrapped on the instance: the position only  |
 * |           | into components/ContextMenuComponent.js:206 `updatePosition`   | + (e) | (its alignment and clamping stay in the component, out of reach)          |
 * |           | features/auto-scroll/AutoScroll.js:69, :145                    | none  | left alone: client px against client px, but its 20 px thresholds are not |
 * |           |                                                                |       | scaled (measured in round 4: a drag is displaced at board zoom 0.1)       |
 * |           | diagram-js-direct-editing lib/TextBox.js:378 resize handle     | (e)   | closure over `clientX`; no service or member leads to it                  |
 * |           | dmn-js-shared lib/components/InputSelect.js:62, the simple     | (e)   | components imported directly by other components                          |
 * |           | mode button of the decision table                              |       |                                                                           |
 * | `own`     | the Miragon renderers' own code, three sites (off by default): | (c)   | wrapped on the instance by the PRIVATE name of a renderer's service and   |
 * |           | the draw tools and drawing handles of Wardley and Event        |       | method: `toCanvasPoint` of `wardleyDrawTool`, `wardleyDrawingHandles`,    |
 * |           | Storming, the palette tooltip of all five, the team band of    |       | `eventStormingDrawTool`, `eventStormingDrawingHandles`;                   |
 * |           | Context Maps' label editor                                     |       | `paletteTooltip.placeBelowPalette`; `cmLabelEditing.isInTeamBand`         |
 * |           | the renderers' other own pointer code (Wardley's label editor, | none  | services of the bundles with private methods too (`wardleyLabelEditing    |
 * |           | colour picker and resize badge, Team Topology's and Context    |       | .labelGeometry`, `ttContextPadPlacement.placementFor`, `cmContextPad      |
 * |           | Maps' pad clamping, Context Maps' fixed pad prompt)            |       | Provider.clampPadIntoView` ...): each would be one more patch like `own`  |
 * |           | found by the batteries of round 4, not reached either: Wardley | none  | `WardleyLabelDragging.onMouseMove` (the one that writes wrong data),      |
 * |           | label drag and keyboard-opened pad menu, Event Storming's      |       | `wardleyKeyboard.clientCenterOf`, `EventStormingColorPicker.open`, the    |
 * |           | colour picker, suggestion list and type menu after an append,  |       | suggestion list's `place`, `.cm-hover-tooltip`; the README's section 4    |
 * |           | Context Maps' hover tooltip                                    |       | lists all sites with their numbers                                        |
 */
import type { MountOptions } from "../types.ts";
import { outerScaleDiagramModule } from "./diagram-module.ts";
import type { Layer } from "./layers.ts";
import { outerScaleTableModule } from "./table-module.ts";

export { DEFAULT_LAYERS, type Layer, LAYERS, readLayers } from "./layers.ts";

/** the modules of a mount with these layers on; no layer, no module (the engine is constructed as in `naive`) */
export function outerScaleMount(layers: readonly Layer[]): MountOptions {
  if (layers.length === 0) return {};
  return {
    diagramModules: [outerScaleDiagramModule(layers)],
    ...(layers.includes("table") ? { tableModules: [outerScaleTableModule(layers)] } : {}),
  };
}
