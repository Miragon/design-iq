/**
 * The page's own @font-face rules, read back from its stylesheets: the
 * widget registers its inlined fonts from them (mcp-app/font.ts), and the
 * PNG export embeds Geist from them (lib/export-font.ts).
 */

/** every @font-face of the document, also inside @media / @supports / @layer */
export function* fontFaceRules(): Generator<CSSFontFaceRule> {
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

/** a font-family value without its quotes */
export const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");
