/**
 * The stylesheets a page of its own has to bring: in the product the SPA's entry imports them
 * (src/main.tsx:1-17), not the editors. BOTH spike pages import this module first, the board page
 * (main.tsx) and the embed frame (embed-main.ts), so an editor looks the same in either.
 *
 * - bpmn-js and dmn-js: the sheets below; dmn-js's own diagram-js.css stays out, like in the SPA.
 * - `@/index.css`: Tailwind's base, the ui-kit theme (tokens, Geist), the bpmn-io theme and the
 *   sizes of the canvas hosts. Its rules are scoped by the host's class: a host needs `bpmn-canvas`
 *   or `dmn-canvas`, and a Miragon renderer's host its spec's `canvasClassName` (`wardley-canvas`,
 *   `tt-canvas`, `es-canvas`, `cm-canvas`, `vc-canvas`), under which Vite scopes the renderer's own
 *   sheet; that sheet loads with the renderer (each spec's `load()`).
 * - the palette offset of index.css is scoped to `#root`: both pages mount into `<div id="root">`.
 */
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import "dmn-js/dist/assets/dmn-js-shared.css";
import "dmn-js/dist/assets/dmn-js-drd.css";
import "dmn-js/dist/assets/dmn-js-decision-table.css";
import "dmn-js/dist/assets/dmn-js-decision-table-controls.css";
import "dmn-js/dist/assets/dmn-js-literal-expression.css";
import "dmn-js/dist/assets/dmn-js-boxed-expression.css";
import "dmn-js/dist/assets/dmn-js-boxed-expression-controls.css";
import "dmn-js/dist/assets/dmn-font/css/dmn.css";
import "@emaarco/dmn-js-simulation/assets/dmn-js-simulation.css";
import "@/index.css";
import "../notations/board/board.css";
import "./board-spike.css";
