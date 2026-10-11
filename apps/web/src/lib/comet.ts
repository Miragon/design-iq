/**
 * The Miragon comet — the one geometry, shared by the React SPA header
 * (components/miragon-comet.tsx) and the vanilla-TS widget toolbars
 * (mcp-app/shell.ts). Path and viewBox are the official CI asset
 * (logo/miragon-komet-gruen.svg) UNCHANGED — the CI forbids redrawing the
 * logo (B5); the colour is the CI green, which does not follow any theme.
 *
 * The favicon (public/favicon.svg) is the official app icon — this same comet
 * on the blue rounded square — copied verbatim from the CI as well;
 * appIconElement draws that very geometry for the widgets' menu header and
 * state cards.
 */
import { CD } from "@designiq/ui-kit/lib/tokens";

export const COMET_VIEW_BOX = "0 0 288.08 89.63";
export const COMET_ASPECT = 288.08 / 89.63;
export const COMET_COLOR = CD.gruen;
export const COMET_PATH =
  "M0,89.63l220.2-14.78c11.65-.78,23.38-2.66,33.31-5.14s22.92-8.94,29.16-19.41c3.65-6.12,5.09-13.73,5.38-18.91,.27-4.94-.99-10.2-2.54-13.33-2.76-5.55-6.11-8.42-8.55-10.26-2.45-1.84-7.55-5.77-18.08-7.35-10.53-1.58-29.62,1.2-44.31,5.84C199.87,10.92,0,89.63,0,89.63Z";

/** the comet as a DOM node, for the widget bundles (no React in there) */
export function cometElement(heightPx: number): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", COMET_VIEW_BOX);
  svg.setAttribute("height", String(heightPx));
  svg.setAttribute("width", (heightPx * COMET_ASPECT).toFixed(1));
  svg.setAttribute("fill", COMET_COLOR);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", COMET_PATH);
  svg.append(path);
  return svg;
}

/** the official app icon (CI logo/miragon-komet-blau.svg, the favicon's
 *  geometry unchanged) as a DOM node, for the widget menu header and state
 *  cards. The fills ride CSS classes — `.appicon-bg` on --primary, `.appicon-comet`
 *  on --brand (mcp-app/chrome.css) — so no colour value is baked in here. */
export function appIconElement(sizePx: number): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 512 512");
  svg.setAttribute("width", String(sizePx));
  svg.setAttribute("height", String(sizePx));
  svg.setAttribute("class", "appicon");
  svg.setAttribute("aria-hidden", "true");
  const square = document.createElementNS(ns, "rect");
  square.setAttribute("width", "512");
  square.setAttribute("height", "512");
  square.setAttribute("rx", "112");
  square.setAttribute("class", "appicon-bg");
  const group = document.createElementNS(ns, "g");
  group.setAttribute("transform", "translate(66 196.9) scale(1.31908)");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", COMET_PATH);
  path.setAttribute("class", "appicon-comet");
  group.append(path);
  svg.append(square, group);
  return svg;
}
