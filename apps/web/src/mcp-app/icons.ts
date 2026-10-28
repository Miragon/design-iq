/**
 * The widget icons — Lucide, the CI's one icon set, exactly as the SPA draws
 * it: every entry is the icon node of lucide-react 1.51.0 under the same name,
 * copied rather than imported (test/widget-icons.test.ts holds the two
 * together). The widgets carry no React, and a dozen inline glyphs weigh less
 * than any icon runtime in a bundle every chat re-downloads. Outline only:
 * stroke currentColor, no fill — a button's colour paints its icon, hover
 * blue included.
 *
 * The static HTML names its icons declaratively (`<button data-icon="x">`);
 * mountIcons fills them once at boot, so each geometry lives here only.
 * The SPA's Markdown view, plain DOM like the widgets, borrows circle-alert
 * for the error notice under a mermaid fence, chevron-right for a <details>
 * summary and corner-up-left for a footnote's link back to its reference.
 * Phase 2 adds git-pull-request (Release → PR) and undo-2 / redo-2 (touch).
 */
export const LUCIDE_ICONS = {
  // the legend (Context Maps, Team Topologies): what the notation's shapes and marks mean
  "book-open":
    '<path d="M12 5v16"/>' +
    '<path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "circle-alert":
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  // test case states (dmn-checks.ts): shape, not just colour, tells them apart
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>',
  "circle-x": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  "circle-question-mark":
    '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  "circle-dashed":
    '<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/>' +
    '<path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/>' +
    '<path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/>' +
    '<path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>',
  // the Markdown view: a footnote's link back to its reference
  "corner-up-left": '<path d="M20 20v-7a4 4 0 0 0-4-4H4"/><path d="M9 14 4 9l5-5"/>',
  "external-link":
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  // the renderers' Export entries (guide §5.14): Export as SVG, Export as PNG
  "file-code-corner":
    '<path d="M4 12.15V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3.35"/>' +
    '<path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m5 16-3 3 3 3"/><path d="m9 22 3-3-3-3"/>',
  "file-image":
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>' +
    '<path d="M14 2v5a1 1 0 0 0 1 1h5"/><circle cx="10" cy="12" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>',
  eye:
    '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  // Keyboard shortcuts… (guide §5.14)
  keyboard:
    '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/>' +
    '<path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  // Add todo — the SPA's name and icon
  "list-plus": '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M16 19H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
  // the SPA's todo icon
  "list-todo":
    '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/>' +
    '<rect x="3" y="4" width="6" height="6" rx="1"/>',
  // spinners: rotated by CSS, a static icon + text under reduced motion
  "loader-circle": '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  "maximize-2": '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
  menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
  // an agent peer's avatar — what an assistant does in the room is write, so a
  // message mark, never a robot or sparkles (CI anti-slop U4)
  "message-square-text":
    '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>' +
    '<path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/>',
  "minimize-2": '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
  minus: '<path d="M5 12h14"/>',
  // the DMN view switch: DRD
  network:
    '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/>' +
    '<rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "rotate-ccw": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  save:
    '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
    '<path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  // Fit to view
  scan:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>' +
    '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  // "Implement" hands a todo to the assistant — what the button DOES is post
  // a work order into the chat, so the icon says that (no sparkles for "AI",
  // CI anti-slop U4)
  send:
    '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>' +
    '<path d="m21.854 2.147-10.94 10.939"/>',
  // Tools — the modelling palette behind a button when compact
  shapes:
    '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>',
  // the SPA's Checks icon (decision checks)
  "shield-check":
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' +
    '<path d="m9 12 2 2 4-4"/>',
  // Workshop mode (t.BPM stickies)
  "sticky-note":
    '<path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/>' +
    '<path d="M15 3v5a1 1 0 0 0 1 1h5"/>',
  // the DMN view switch: Table
  "table-2": '<path d="M3 9h18"/><path d="M9 3v18"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

export type IconName = keyof typeof LUCIDE_ICONS;

const SVG_NS = "http://www.w3.org/2000/svg";

/** a Lucide icon as a DOM node — decorative (aria-hidden): the control that
 *  carries it owns the accessible name (its text, title or aria-label).
 *  `cls` joins "icon" (chrome.css `.icon.spin` rotates a loader-circle).
 *  `doc` is the document to create it in: the SPA's Markdown view, which
 *  builds its DOM without React, passes its own (it runs under jsdom too). */
export function icon(name: IconName, size = 16, cls?: string, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  const attrs: Array<[string, string]> = [
    ["viewBox", "0 0 24 24"],
    ["width", String(size)],
    ["height", String(size)],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["aria-hidden", "true"],
    ["class", cls ? `icon ${cls}` : "icon"],
  ];
  for (const [key, value] of attrs) svg.setAttribute(key, value);
  // innerHTML on an SVG element parses its children in the SVG namespace
  svg.innerHTML = LUCIDE_ICONS[name];
  return svg;
}

/** fill every `[data-icon]` placeholder of the static HTML, icon first;
 *  `data-icon-size` overrides the 16px chrome size (14px next to text) */
export function mountIcons(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = node.dataset.icon as IconName;
    if (!(name in LUCIDE_ICONS)) continue;
    node.prepend(icon(name, Number(node.dataset.iconSize ?? 16)));
    delete node.dataset.icon; // idempotent: a second call finds nothing left to fill
  }
}
