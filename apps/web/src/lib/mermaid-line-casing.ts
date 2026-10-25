/**
 * The casing under an xy chart's lines, drawn on the page's side of a
 * Mermaid diagram (#294). The CI theme (lib/mermaid-render.ts) gives an xy
 * chart's bars and lines the same two greys, so a line reads 1.7:1 where it
 * crosses a bar of the other grey and vanishes across a bar of its own. A
 * casing in the plot's white under the line keeps it at 3:1 whatever it
 * crosses: the design guide's label halo in the surface behind (§10.1,
 * --cd-ui-plot), laid under a line. Unlike the guide's Unterleger (§10.6),
 * 2 px wider in all and seen only in dark mode, it shows in light and
 * reaches 2 px past each side. CSS cannot draw a second path, and WebKit
 * draws no CSS filter (a drop-shadow casing) on an element inside an SVG.
 * mermaid hands the page a finished SVG string, so the page adds it once
 * the diagram is sanitized (mermaid-fence.ts).
 *
 * Node-loadable like the Markdown view (test/mermaid-engine.test.ts runs it
 * on mermaid's own drawings under jsdom).
 */
import { ALIASES } from "@designiq/ui-kit/lib/tokens";

const SVG_NS = "http://www.w3.org/2000/svg";

/** the class of a casing path, which a later pass over the same drawing skips */
export const LINE_CASING_CLASS = "xy-line-casing";
/**
 * How far the plot's white under an xy chart's marks reaches past them, in
 * screen pixels: the casing under a line (here) and the rim under a bar
 * (lib/mermaid-render.ts). 1 px leaves anti-aliased greys below 3:1. Both
 * keep it as the chart shrinks to a column narrower than its natural size
 * (vector-effect: non-scaling-stroke); mermaid never draws it larger.
 */
export const XY_HALO_REACH = 2;

/** an xy chart's line: mermaid draws each in a group `line-plot-<n>`, its point labels in a group beside the path */
const XY_LINE = `[class^="line-plot-"] > path:not(.${LINE_CASING_CLASS})`;

/**
 * Lay a casing in the plot's white under every line of an xy chart in `svg`.
 * Round joins and caps on both: the line's own miter tips would reach past
 * a round casing at a sharp turn, and a line of one point (`M x,y Z`) would
 * draw nothing on the white disc its casing leaves. A round line stays
 * inside its casing by the full reach and shows such a point as a dot.
 */
export function caseXyChartLines(svg: Element): void {
  for (const line of svg.querySelectorAll(XY_LINE)) {
    if (line.previousElementSibling?.classList.contains(LINE_CASING_CLASS)) continue;
    const width = Number.parseFloat(line.getAttribute("stroke-width") ?? "") || 1;
    const casing = line.ownerDocument.createElementNS(SVG_NS, "path");
    casing.setAttribute("class", LINE_CASING_CLASS);
    casing.setAttribute("d", line.getAttribute("d") ?? "");
    casing.setAttribute("fill", "none");
    casing.setAttribute("stroke", ALIASES["canvas-background"]);
    casing.setAttribute("stroke-width", String(width + 2 * XY_HALO_REACH));
    casing.setAttribute("vector-effect", "non-scaling-stroke");
    casing.setAttribute("stroke-linejoin", "round");
    casing.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-linecap", "round");
    line.before(casing);
  }
}
