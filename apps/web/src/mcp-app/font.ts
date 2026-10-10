/**
 * The inlined widget fonts, CSP-proof: Geist (the CI typeface, geist.css —
 * plus Geist Mono in the decision widget) and the notation icon font (bpmn /
 * dmn). MCP-App hosts run the iframe under a strict CSP whose font-src blocks
 * even data: URLs, so an inlined @font-face never loads there (Geist falls
 * back to the system sans; palette, context pad and the decision-table
 * controls show tofu). A FontFace constructed from an
 * ArrayBuffer is no URL load — no CSP directive applies.
 *
 * The font bytes are NOT bundled twice: the inlined stylesheet already
 * carries them as data: URIs, so we read the rules back from the stylesheet,
 * decode them ourselves (atob, not fetch — a fetch would fall under
 * connect-src) and register the faces programmatically — EVERY rule of the
 * family with its own descriptors, so Geist's unicode-range subsets and its
 * weight axis survive the rescue. In a plain browser both paths load; same
 * family, no visible difference.
 *
 * Geist also goes in under the family name "Geist" (FONT_ALIASES): the
 * event-storming and wardley renderers set their canvas text in 'Geist', the
 * CI's spelling, not fontsource's "Geist Variable". An alias face is built from
 * the same decoded bytes — no second data: rule in geist.css, so the bundle
 * still carries them once.
 */

/** the CI typeface, as geist.css (and tokens.css' --designiq-font-sans) names it */
export const WIDGET_FONT = "Geist Variable";
/** its mono cut, as geist-mono.css (and --designiq-font-mono) names it */
export const WIDGET_FONT_MONO = "Geist Mono Variable";

/** the further names a family is registered under — what bundled renderers
 *  ask for (ui-kit's fonts.css does the same for the SPA) */
const FONT_ALIASES: Readonly<Record<string, readonly string[]>> = { [WIDGET_FONT]: ["Geist"] };

/** CSS descriptor → FontFace descriptor; src and family are taken separately */
const DESCRIPTORS = [
  ["font-weight", "weight"],
  ["font-style", "style"],
  ["font-stretch", "stretch"],
  ["unicode-range", "unicodeRange"],
  ["font-display", "display"],
] as const;

export async function loadInlinedFont(family: string): Promise<void> {
  const faces: FontFace[] = [];
  for (const rule of fontFaceRules()) {
    if (unquote(rule.style.getPropertyValue("font-family")) !== family) continue;
    const src = rule.style.getPropertyValue("src");
    // the src list may carry several formats — FontFace needs a modern one
    const dataUri =
      /url\("?(data:font\/woff2[^")]+)"?\)/.exec(src)?.[1] ??
      /url\("?(data:font\/woff[^")]+)"?\)/.exec(src)?.[1] ??
      /url\("?(data:font\/ttf[^")]+)"?\)/.exec(src)?.[1];
    const descriptors: Record<string, string> = {};
    for (const [css, key] of DESCRIPTORS) {
      const value = rule.style.getPropertyValue(css).trim();
      if (value) descriptors[key] = value;
    }
    // the values come out of a rule the browser already parsed — valid by construction
    const faceDescriptors = descriptors as FontFaceDescriptors;
    const aliases = FONT_ALIASES[family] ?? [];
    if (!dataUri) {
      // a URL rule (the dev server, no host CSP) loads through the sheet —
      // nothing to rescue, but its aliases take the same src: still one fetch.
      // An svg-only rule (dmn.css' webkit block) has no aliases.
      for (const alias of aliases) faces.push(new FontFace(alias, src, faceDescriptors));
      continue;
    }
    const bytes = decode(dataUri);
    faces.push(new FontFace(family, bytes, faceDescriptors));
    // each alias face gets its own copy: none may depend on another's buffer
    for (const alias of aliases) faces.push(new FontFace(alias, bytes.slice(0), faceDescriptors));
  }
  await Promise.all(
    faces.map(async (face) => {
      await face.load();
      document.fonts.add(face);
    }),
  );
}

/** every @font-face of the document, also inside @media / @supports / @layer */
function* fontFaceRules(): Generator<CSSFontFaceRule> {
  const walk = function* (rules: CSSRuleList): Generator<CSSFontFaceRule> {
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) yield rule;
      else if (rule instanceof CSSGroupingRule) yield* walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet hides its rules — never one of ours
    }
    yield* walk(rules);
  }
}

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

function decode(dataUri: string): ArrayBuffer {
  const bin = atob(dataUri.slice(dataUri.indexOf("base64,") + 7));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
