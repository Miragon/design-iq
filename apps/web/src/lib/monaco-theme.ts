/**
 * The "designiq" Monaco theme (#238) — the source view and the history text
 * diff on the Miragon CI. Monaco paints with its own colour registry and
 * rejects CSS custom properties, so every value here comes from the TS mirror
 * of the tokens (@designiq/ui-kit/lib/tokens) as hex — the same values
 * tokens.css resolves to, drift-tested there.
 *
 * Monaco is a parameter, not an import: callers pass `monaco.editor`, so the
 * theme data stays importable (and contrast-tested) under node --test without
 * loading the editor.
 */
import { ALIASES, CD, FONT_MONO, mix } from "@designiq/ui-kit/lib/tokens";
import type { editor } from "monaco-editor";

export const MONACO_THEME = "designiq";

const FONT_SIZE = 13;

/** the editor options every designIQ Monaco shares — spread FIRST, so a
 *  caller's own options (readOnly, model, …) still win */
export const MONACO_OPTIONS = {
  theme: MONACO_THEME,
  // Geist Mono (CI §4: code and fixed measures); 13px is the CI's "klein"
  // step — the smallest size it sets text in
  fontFamily: FONT_MONO,
  fontSize: FONT_SIZE,
  lineHeight: 20,
  // pinned, not left to the default: this text is what gets committed — every
  // character drawn as typed
  fontLigatures: false,
  padding: { top: 8 },
} as const satisfies editor.IStandaloneEditorConstructionOptions;

/** a token colour Monaco accepts (opaque; it ignores a rule's alpha) */
const fg = (hex: string): string => hex.slice(0, 7);
/** `color` at `pct` % over nothing — Monaco blends #rrggbbaa itself */
const tint = (color: string, pct: number): string => mix(color, pct, "transparent");

// The syntax colours — five roles. The base "vs" theme's pure red attribute
// names and #0000FF values are the loudest thing on a BPMN XML screen; the CI
// blues lead instead, green reads as data.
const SYNTAX = {
  /** tags, keywords, headings — the structure: the CI's interactive blue */
  structure: CD.blauLink,
  /** attribute names, JSON/YAML keys — blue deepened toward schwarz: the tag's
   *  family, told apart from it by depth */
  name: mix(CD.blau, 55, CD.schwarz),
  /** attribute values, strings — success is the CI green that passes as text */
  literal: CD.success,
  /** numbers and constants */
  number: CD.warning,
  /** comments, punctuation, the XML prolog — secondary text */
  quiet: ALIASES["muted-foreground"],
} as const;

// Text keeps ≥ 4.5:1 in every syntax colour (test/monaco-theme.test.ts) on
// the grounds Monaco really paints — and it STACKS its highlights: the cursor's
// word on the current line, a double-clicked word under its own selection, the
// current find match (the selection) on the range-highlighted line. The CI's
// text green and ochre reach only ≈ 5.3:1 on white, so ~11 % of blue is the
// whole budget, not a per-state one. The selection spends it; every other state
// (current line, occurrences, brackets, find matches) is a frame — ≥ 3:1 where
// it must be found — or a gutter mark. Only the read-only diff tints its lines;
// a selection dragged across them adds its blue (not covered).
/** no fill at all: the state draws a frame instead */
const NONE = tint(CD.weiss, 0);

export const designiqTheme: editor.IStandaloneThemeData = {
  base: "vs",
  inherit: true,
  // `inherit` keeps every vs rule for the languages not listed here; the
  // language-suffixed vs rules (delimiter.xml, string.key.json …) are more
  // specific than a bare token, so each one in use is overridden explicitly
  rules: [
    { token: "", foreground: fg(ALIASES.foreground), background: fg(ALIASES.card) },
    { token: "comment", foreground: fg(SYNTAX.quiet) },
    { token: "annotation", foreground: fg(SYNTAX.quiet) },
    { token: "delimiter", foreground: fg(SYNTAX.quiet) },
    { token: "delimiter.xml", foreground: fg(SYNTAX.quiet) },
    { token: "delimiter.html", foreground: fg(SYNTAX.quiet) },
    { token: "metatag", foreground: fg(SYNTAX.quiet) },
    { token: "metatag.xml", foreground: fg(SYNTAX.quiet) },
    { token: "metatag.html", foreground: fg(SYNTAX.quiet) },
    { token: "metatag.content.html", foreground: fg(SYNTAX.literal) },
    { token: "tag", foreground: fg(SYNTAX.structure) },
    { token: "keyword", foreground: fg(SYNTAX.structure) },
    { token: "keyword.json", foreground: fg(SYNTAX.structure) },
    { token: "keyword.flow", foreground: fg(SYNTAX.structure) },
    { token: "variable.predefined", foreground: fg(SYNTAX.structure) },
    { token: "string.link", foreground: fg(SYNTAX.structure) },
    { token: "attribute.name", foreground: fg(SYNTAX.name) },
    { token: "string.key.json", foreground: fg(SYNTAX.name) },
    { token: "type", foreground: fg(SYNTAX.name) }, // YAML keys
    { token: "key", foreground: fg(SYNTAX.name) },
    { token: "variable", foreground: fg(SYNTAX.name) },
    { token: "attribute.value", foreground: fg(SYNTAX.literal) },
    { token: "attribute.value.xml", foreground: fg(SYNTAX.literal) },
    { token: "attribute.value.html", foreground: fg(SYNTAX.literal) },
    { token: "string", foreground: fg(SYNTAX.literal) },
    { token: "string.html", foreground: fg(SYNTAX.literal) },
    { token: "string.value.json", foreground: fg(SYNTAX.literal) },
    { token: "string.yaml", foreground: fg(SYNTAX.literal) },
    { token: "number", foreground: fg(SYNTAX.number) },
    { token: "number.hex", foreground: fg(SYNTAX.number) },
    { token: "attribute.value.number", foreground: fg(SYNTAX.number) },
    { token: "attribute.value.unit", foreground: fg(SYNTAX.number) },
    { token: "constant", foreground: fg(SYNTAX.number) },
    { token: "regexp", foreground: fg(SYNTAX.number) },
    { token: "invalid", foreground: fg(CD.danger) },
  ],
  colors: {
    "editor.background": ALIASES.card,
    "editor.foreground": ALIASES.foreground,
    "editorGutter.background": ALIASES.card,
    "editorLineNumber.foreground": ALIASES["muted-foreground"],
    "editorLineNumber.activeForeground": ALIASES.foreground,
    // the current line: a frame in linie, never a band — the cursor's word and
    // bracket highlights land on it (the active line number says it too)
    "editor.lineHighlightBackground": NONE,
    "editor.lineHighlightBorder": ALIASES.border,
    "editorCursor.foreground": ALIASES.link,

    // selection: the CI blue, soft — 11 %, as the CI's 12 % "-soft" rounds
    // (alpha byte) to just under 4.5:1 for the text green; weaker while the
    // editor is unfocused. The budget is spent there: whatever Monaco paints on
    // or beside a selection (the word's own highlight, its other occurrences,
    // the find matches) is a frame
    "editor.selectionBackground": tint(CD.blau, 11),
    "editor.inactiveSelectionBackground": tint(CD.blau, 8),
    "editor.selectionHighlightBackground": NONE,
    "editor.selectionHighlightBorder": tint(CD.blau, 40),
    "editor.wordHighlightBackground": NONE,
    "editor.wordHighlightBorder": tint(CD.blau, 40),
    "editor.wordHighlightTextBackground": NONE,
    "editor.wordHighlightTextBorder": tint(CD.blau, 40),
    "editor.wordHighlightStrongBackground": NONE,
    "editor.wordHighlightStrongBorder": tint(CD.blau, 70),
    "editorBracketMatch.background": NONE,
    "editorBracketMatch.border": ALIASES.input,
    // a folded line: its ⋯ and the gutter chevron say it — no tint under a selection
    "editor.foldBackground": NONE,
    "editorLink.activeForeground": ALIASES.link,

    // find: frames in the CI's text green — any match can lie under the
    // selection (Cmd+F seeds from it, a double-click selects one). The current
    // match is the selection plus the ≥ 3:1 frame, on a line left unbanded (vs
    // paints it yellow). The find-in-selection scope gets no fill either: the
    // selection and its matches sit on it, and a whole-line frame would rule
    // every line
    "editor.findMatchBackground": NONE,
    "editor.findMatchBorder": CD.success,
    "editor.findMatchHighlightBackground": NONE,
    "editor.findMatchHighlightBorder": tint(CD.success, 50),
    "editor.findRangeHighlightBackground": NONE,
    "editor.rangeHighlightBackground": NONE,
    // their scrollbar marks: vs paints them orange and VS Code blue
    "editorOverviewRuler.findMatchForeground": tint(CD.success, 60),
    "editorOverviewRuler.rangeHighlightForeground": tint(CD.blau, 60),

    // structure lines: decorative lines in linie, the active block in kontur.
    // Whitespace dots render inside the selection — linie would vanish there
    "editorIndentGuide.background1": ALIASES.border,
    "editorIndentGuide.activeBackground1": ALIASES.input,
    "editorWhitespace.foreground": ALIASES.input,
    "editorRuler.foreground": ALIASES.border,
    // bracket-pair colours on the JSON notations: CI blue, green, ochre
    "editorBracketHighlight.foreground1": SYNTAX.structure,
    "editorBracketHighlight.foreground2": SYNTAX.literal,
    "editorBracketHighlight.foreground3": SYNTAX.number,
    "editorBracketHighlight.unexpectedBracket.foreground": CD.danger,

    // scrollbars: kontur, translucent — present, never louder than the text
    "scrollbarSlider.background": tint(CD.kontur, 28),
    "scrollbarSlider.hoverBackground": tint(CD.kontur, 45),
    "scrollbarSlider.activeBackground": tint(CD.kontur, 60),
    // shadows tinted with the CI black, as --cd-shadow-*
    "scrollbar.shadow": tint(CD.schwarz, 10),
    "widget.shadow": tint(CD.schwarz, 16),
    "editorOverviewRuler.border": ALIASES.border,
    "editorStickyScroll.background": ALIASES.card,
    "editorStickyScroll.shadow": tint(CD.schwarz, 10),

    // widgets (find, hover, suggest, context menu): the popover surface
    "editorWidget.background": ALIASES.popover,
    "editorWidget.foreground": ALIASES["popover-foreground"],
    "editorWidget.border": ALIASES.border,
    "editorWidget.resizeBorder": ALIASES.border,
    "editorHoverWidget.background": ALIASES.popover,
    "editorHoverWidget.foreground": ALIASES["popover-foreground"],
    "editorHoverWidget.border": ALIASES.border,
    "editorSuggestWidget.background": ALIASES.popover,
    "editorSuggestWidget.foreground": ALIASES["popover-foreground"],
    "editorSuggestWidget.border": ALIASES.border,
    "editorSuggestWidget.selectedBackground": ALIASES.accent,
    "editorSuggestWidget.selectedForeground": ALIASES.foreground,
    "editorSuggestWidget.highlightForeground": ALIASES.link,
    "editorSuggestWidget.focusHighlightForeground": ALIASES.link,
    "list.hoverBackground": ALIASES.accent,
    "menu.background": ALIASES.popover,
    "menu.foreground": ALIASES["popover-foreground"],
    "menu.border": ALIASES.border,
    "menu.selectionBackground": ALIASES.accent,
    "menu.selectionForeground": ALIASES["accent-foreground"],
    "menu.separatorBackground": ALIASES.border,
    focusBorder: ALIASES.ring,
    errorForeground: CD.danger,
    "input.background": ALIASES.background,
    "input.foreground": ALIASES.foreground,
    "input.border": ALIASES.input,
    "input.placeholderForeground": ALIASES["muted-foreground"],
    "inputOption.activeBorder": ALIASES.ring,
    "inputOption.activeBackground": ALIASES.accent,
    "inputOption.activeForeground": ALIASES.link,
    "editorError.foreground": CD.danger,
    "editorWarning.foreground": CD.warning,
    "editorInfo.foreground": CD.info,

    // the history diff: the CI status tints, light enough that the changed
    // CHARACTERS (a second wash on the line's) keep every syntax colour
    // ≥ 4.5:1 too. Inserted ones take the green highlighter (CI §3.7), which
    // stands out by hue where a deeper success tint would have to darken; the
    // CI has no light red, so removed ones stay a quiet danger wash, on a line
    // a step lighter to leave it room. A frame would not do: Monaco draws the
    // text border around the whole line too. The gutter carries the strongest
    // mark.
    "diffEditor.insertedLineBackground": tint(CD.success, 6),
    "diffEditor.insertedTextBackground": tint(CD.gruen, 12),
    "diffEditorGutter.insertedLineBackground": tint(CD.success, 14),
    "diffEditor.removedLineBackground": tint(CD.danger, 5),
    "diffEditor.removedTextBackground": tint(CD.danger, 5),
    "diffEditorGutter.removedLineBackground": tint(CD.danger, 14),
    "diffEditorOverview.insertedForeground": tint(CD.success, 60),
    "diffEditorOverview.removedForeground": tint(CD.danger, 60),
    "diffEditor.border": ALIASES.border,
    "diffEditor.diagonalFill": tint(CD.kontur, 25),
    "diffEditor.unchangedRegionBackground": ALIASES.secondary,
    "diffEditor.unchangedRegionForeground": ALIASES["muted-foreground"],
  },
};

/** the slice of `monaco.editor` the installer touches */
export type MonacoEditorApi = Pick<typeof editor, "defineTheme" | "remeasureFonts">;

let installed = false;

/**
 * Define the theme once per page — call before every editor create; repeat
 * calls are no-ops. Monaco measures glyph widths when an editor is created,
 * so an editor that opens before Geist Mono has downloaded would place its
 * cursor and selections on the FALLBACK font's metrics: once the face is in,
 * every editor re-measures.
 */
export function installMonacoTheme(api: MonacoEditorApi): void {
  if (installed) return;
  installed = true;
  api.defineTheme(MONACO_THEME, designiqTheme);
  globalThis.document?.fonts?.load(`${FONT_SIZE}px ${FONT_MONO}`).then(
    () => api.remeasureFonts(),
    () => {
      /* font unavailable — the fallback stack measured right the first time */
    },
  );
}
