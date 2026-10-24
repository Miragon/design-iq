/**
 * Geist inside a diagram's SVG before it becomes a PNG. An SVG drawn as an
 * image is a document of its own: the page's fonts do not reach it, and its
 * labels would fall back to the system sans. Every Miragon renderer names
 * 'Geist Variable' first in its text's font-family, so the page's own rules
 * of that family go into the SVG's <style> with their bytes inline: the
 * widget's are data: URIs already (geist.css), the SPA's are fontsource files
 * of its own origin, fetched once. A data: font inside an SVG image loads
 * under the MCP hosts' CSP too: their font-src stops the widget's own data:
 * rules (mcp-app/font.ts), not the image's (checked in Chromium and WebKit,
 * test/png-export-font-chromium.ts).
 *
 * Only the subsets whose unicode-range holds a character of the diagram's
 * text go in. The SPA has every fontsource subset (latin, latin-ext, cyrillic,
 * cyrillic-ext, vietnamese); the widget carries latin and latin-ext alone, so
 * there other scripts stay in the system sans, as they do on its canvas.
 *
 * The SVG download stays as it is: it shows Geist where the font is installed
 * and the system sans elsewhere (guide §4).
 */
import { fontFaceRules, unquote } from "./font-face-rules.ts";

/** the family every renderer names first in its text's font-family */
export const EXPORT_FONT = "Geist Variable";

/** each embedded face once more under a family of its own, the one font of a hidden text */
export const PRELOAD_FONT = "designiq-export-preload";

const SVG_NS = "http://www.w3.org/2000/svg";

/** what a face keeps of its rule: the family is fixed, src goes in inline */
const DESCRIPTORS = ["font-style", "font-weight", "font-stretch", "unicode-range"] as const;

/** the parts of a CSSFontFaceRule read here */
export interface FontFaceSource {
  readonly style: Pick<CSSStyleDeclaration, "getPropertyValue">;
  readonly parentStyleSheet: Pick<CSSStyleSheet, "href"> | null;
}

/** one subset of Geist as it goes into the SVG */
export interface EmbeddedFace {
  /** its @font-face rule, the file inline */
  readonly rule: string;
  /** that file as a data: URL */
  readonly src: string;
}

/** each fetched font file as a data: URL, once per page; a failed read is tried again next time */
const inlined = new Map<string, Promise<string>>();

/** the SVG with the Geist faces its text needs in a <style> up front; throws
 *  when the SVG cannot be parsed or the page has no Geist to give */
export async function embedGeist(svg: string, rules: Iterable<FontFaceSource> = fontFaceRules()): Promise<string> {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.namespaceURI !== SVG_NS || parsed.getElementsByTagName("parsererror").length > 0) {
    throw new Error("the diagram's SVG cannot be parsed");
  }
  const faces = await geistFontFaces(root.textContent ?? "", rules);
  if (faces.length === 0) return svg;
  const defs = parsed.createElementNS(SVG_NS, "defs");
  const style = parsed.createElementNS(SVG_NS, "style");
  style.textContent =
    faces.map((face) => face.rule).join("") +
    faces.map((face, index) => `@font-face{font-family:'${PRELOAD_FONT}-${index}';src:url("${face.src}");}`).join("");
  defs.append(style);
  // Chromium calls an SVG image loaded once the faces that are some text's
  // first font have loaded; a subset that only a later glyph asks for (Ł
  // after latin) is still loading when the PNG is drawn, and under it no
  // label shows. A hidden text per face makes every one a first font.
  const preload = parsed.createElementNS(SVG_NS, "g");
  preload.setAttribute("visibility", "hidden");
  for (const index of faces.keys()) {
    const text = parsed.createElementNS(SVG_NS, "text");
    text.setAttribute("font-family", `'${PRELOAD_FONT}-${index}'`);
    text.textContent = "x";
    preload.append(text);
  }
  root.insertBefore(preload, root.firstChild);
  root.insertBefore(defs, preload);
  return new XMLSerializer().serializeToString(parsed);
}

/** the subsets of the page's Geist that `text` uses, each file a data: URL */
export async function geistFontFaces(text: string, rules: Iterable<FontFaceSource>): Promise<EmbeddedFace[]> {
  const faces = [...rules].filter((rule) => unquote(rule.style.getPropertyValue("font-family")) === EXPORT_FONT);
  if (faces.length === 0) throw new Error(`the page has no ${EXPORT_FONT}`);
  const codePoints = [...new Set(Array.from(text, (char) => char.codePointAt(0)!))];
  const used = faces.filter((rule) => covers(rule.style.getPropertyValue("unicode-range"), codePoints));
  return Promise.all(
    used.map(async (rule) => {
      const descriptors = DESCRIPTORS.map((name) => [name, rule.style.getPropertyValue(name).trim()] as const)
        .filter(([, value]) => value)
        .map(([name, value]) => `${name}:${value};`)
        .join("");
      const src = await dataUrl(rule);
      // swap: should a face still be loading when the image is drawn, its
      // labels show in the system sans, where block would leave them out
      return {
        rule: `@font-face{font-family:'${EXPORT_FONT}';${descriptors}font-display:swap;src:url("${src}");}`,
        src,
      };
    }),
  );
}

/** whether a face with this unicode-range draws any of the code points; no range is every one */
export function covers(unicodeRange: string, codePoints: readonly number[]): boolean {
  if (codePoints.length === 0) return false;
  if (!unicodeRange.trim()) return true;
  const ranges = unicodeRange.split(",").flatMap((part): [number, number][] => {
    const match = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!match) return [];
    const [, start = "", end] = match;
    if (start.includes("?")) {
      return [[Number.parseInt(start.replaceAll("?", "0"), 16), Number.parseInt(start.replaceAll("?", "f"), 16)]];
    }
    return [[Number.parseInt(start, 16), Number.parseInt(end ?? start, 16)]];
  });
  return codePoints.some((point) => ranges.some(([low, high]) => point >= low && point <= high));
}

function dataUrl(rule: FontFaceSource): Promise<string> {
  const src = /url\(\s*(["']?)(.*?)\1\s*\)/.exec(rule.style.getPropertyValue("src"))?.[2];
  if (!src) return Promise.reject(new Error(`a ${EXPORT_FONT} rule names no file`));
  if (src.startsWith("data:")) return Promise.resolve(src);
  const href = new URL(src, rule.parentStyleSheet?.href ?? document.baseURI).href;
  let reading = inlined.get(href);
  if (!reading) {
    reading = read(href);
    inlined.set(href, reading);
    reading.catch(() => inlined.delete(href));
  }
  return reading;
}

async function read(href: string): Promise<string> {
  const response = await fetch(href);
  if (!response.ok) throw new Error(`${href} answered ${response.status}`);
  const type = response.headers.get("content-type")?.split(";")[0]?.trim();
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  // in slices: a spread of the whole file would pass more arguments than a call takes
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${type?.startsWith("font/") ? type : "font/woff2"};base64,${btoa(binary)}`;
}
