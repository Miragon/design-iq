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
 */
export const LUCIDE_ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  // test case states (dmn-tests.ts): shape, not just colour, tells them apart
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>',
  "circle-x": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  "circle-question-mark":
    '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  "circle-dashed":
    '<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/>' +
    '<path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/>' +
    '<path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/>' +
    '<path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>',
  "external-link":
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  // the SPA's Checks icon
  "flask-conical":
    '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/>' +
    '<path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  // the SPA's todo icon
  "list-todo":
    '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/>' +
    '<rect x="3" y="4" width="6" height="6" rx="1"/>',
  maximize:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>' +
    '<path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  // "Implement" hands a todo to the assistant — what the button DOES is post
  // a work order into the chat, so the icon says that (no sparkles for "AI",
  // CI anti-slop U4)
  send:
    '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>' +
    '<path d="m21.854 2.147-10.94 10.939"/>',
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

export type IconName = keyof typeof LUCIDE_ICONS;

const SVG_NS = "http://www.w3.org/2000/svg";

/** a Lucide icon as a DOM node — decorative (aria-hidden): the control that
 *  carries it owns the accessible name (its text, title or aria-label) */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
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
    ["class", "icon"],
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
