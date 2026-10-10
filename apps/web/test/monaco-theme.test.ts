/**
 * The Monaco theme and the presence colours on the Miragon CI (#238): Monaco
 * takes literal hex only, so these are the values tokens.css cannot reach —
 * contrast is checked here, against the tints the text actually sits on: as
 * Monaco stacks them, not one at a time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PRESENCE_COLORS } from "@designiq/contracts/live";
import { ALIASES, CD, formatColor, mix, parseColor } from "@designiq/ui-kit/lib/tokens";

import { designiqTheme, installMonacoTheme, MONACO_THEME, type MonacoEditorApi } from "../src/lib/monaco-theme.ts";
import { FALLBACK_PRESENCE_COLOR } from "../src/lib/presence-format.ts";
import { REMOTE_SELECTION_ALPHA } from "../src/lib/remote-carets.ts";

const luminance = (color: string): number => {
  const [r, g, b] = parseColor(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** a translucent colour as it lands on an opaque ground */
const over = (color: string, ground: string): string => {
  const [r, g, b, a] = parseColor(color);
  return mix(formatColor([r, g, b, 1]), a * 100, ground);
};

const colors = designiqTheme.colors;
const color = (key: string): string => {
  const value = colors[key];
  assert.ok(value, `theme colour ${key} missing`);
  return value;
};
const ground = color("editor.background");

test("monaco theme: every colour is literal hex — Monaco rejects var()", () => {
  for (const [key, value] of Object.entries(colors)) {
    assert.match(value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, key);
  }
  for (const rule of designiqTheme.rules) {
    if (rule.foreground) assert.match(rule.foreground, /^#[0-9a-f]{6}$/i, rule.token);
  }
});

// The grounds text really sits on: Monaco STACKS its highlights, so each is a
// pile of the washes one flow paints — bottom to top as Monaco layers them
// (current line, selection, whole-line decorations, then the inline ones).
const SELECTIONS = ["editor.selectionBackground", "editor.inactiveSelectionBackground"];
const WORDS = [
  "editor.wordHighlightBackground",
  "editor.wordHighlightStrongBackground",
  "editor.wordHighlightTextBackground",
];
const STACKS: Record<string, string[]> = {
  editor: [],
  // the cursor in a word: the current line under the word's highlight, or
  // under the matching bracket
  ...Object.fromEntries(WORDS.map((word) => [`current line + ${word}`, ["editor.lineHighlightBackground", word]])),
  "current line + bracket": ["editor.lineHighlightBackground", "editorBracketMatch.background"],
  // a double-clicked word: the selection under the word's own highlight; its
  // other occurrences get the selection highlight as well
  ...Object.fromEntries(SELECTIONS.flatMap((sel) => WORDS.map((word) => [`${sel} + ${word}`, [sel, word]]))),
  ...Object.fromEntries(
    WORDS.map((word) => [`${word} + selection highlight`, [word, "editor.selectionHighlightBackground"]]),
  ),
  // find: Cmd+F seeds from the selection, so a plain match lies under it until
  // Enter makes it current — on the range-highlighted line, maybe inside the
  // find-in-selection scope, with the word highlight when the editor has focus
  ...Object.fromEntries(
    SELECTIONS.flatMap((sel) => [
      [`${sel} + find match`, [sel, "editor.findMatchHighlightBackground", "editor.wordHighlightTextBackground"]],
      [
        `${sel} + current find match`,
        [
          sel,
          "editor.findRangeHighlightBackground",
          "editor.rangeHighlightBackground",
          "editor.findMatchBackground",
          "editor.wordHighlightTextBackground",
        ],
      ],
    ]),
  ),
  "other find matches": [
    "editor.findRangeHighlightBackground",
    "editor.findMatchHighlightBackground",
    "editor.selectionHighlightBackground",
    "editor.wordHighlightTextBackground",
  ],
  // a selection on a folded line
  ...Object.fromEntries(SELECTIONS.map((sel) => [`${sel} + folded line`, [sel, "editor.foldBackground"]])),
  // the history diff: the changed characters on their changed line
  "inserted line": ["diffEditor.insertedLineBackground"],
  "inserted characters": ["diffEditor.insertedLineBackground", "diffEditor.insertedTextBackground"],
  "removed line": ["diffEditor.removedLineBackground"],
  "removed characters": ["diffEditor.removedLineBackground", "diffEditor.removedTextBackground"],
};

test("monaco theme: syntax text ≥ 4.5:1 on every ground Monaco stacks up", () => {
  for (const [name, layers] of Object.entries(STACKS)) {
    const bg = layers.reduce((under, key) => over(color(key), under), ground);
    for (const rule of designiqTheme.rules) {
      if (!rule.foreground) continue;
      const ratio = contrast(rule.foreground, bg);
      assert.ok(ratio >= 4.5, `${rule.token || "default"} on ${name}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("monaco theme: gutter text ≥ 4.5:1, cursor and frames ≥ 3:1", () => {
  for (const gutter of [
    ground,
    over(color("diffEditorGutter.insertedLineBackground"), ground),
    over(color("diffEditorGutter.removedLineBackground"), ground),
  ]) {
    assert.ok(contrast(color("editorLineNumber.foreground"), gutter) >= 4.5, `line numbers on ${gutter}`);
  }
  assert.ok(
    contrast(color("editorLineNumber.activeForeground"), over(color("editor.lineHighlightBackground"), ground)) >= 4.5,
  );
  for (const key of [
    "editorCursor.foreground",
    "focusBorder",
    "input.border",
    "editor.findMatchBorder",
    "editorBracketMatch.border",
  ]) {
    assert.ok(contrast(color(key), ground) >= 3, `${key}: ${contrast(color(key), ground).toFixed(2)}:1`);
  }
  // green is a highlighter fill only — never the text colour (CI §3.7)
  for (const rule of designiqTheme.rules) assert.notEqual(rule.foreground?.toUpperCase(), CD.gruen);
});

test("installMonacoTheme: defines the theme once, re-measures once Geist Mono is in", async () => {
  const defined: string[] = [];
  let remeasured = 0;
  const api = {
    defineTheme: (name: string) => void defined.push(name),
    remeasureFonts: () => void remeasured++,
  } as unknown as MonacoEditorApi;
  const loads: string[] = [];
  const doc = { fonts: { load: async (font: string) => void loads.push(font) } };
  (globalThis as { document?: unknown }).document = doc;
  try {
    installMonacoTheme(api);
    installMonacoTheme(api);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
  assert.deepEqual(defined, [MONACO_THEME]);
  assert.equal(loads.length, 1);
  assert.match(loads[0] ?? "", /Geist Mono/);
  assert.equal(remeasured, 1);
});

test("presence palette: the CI entries are the CI tokens; the fallback is the CI neutral", () => {
  const palette = PRESENCE_COLORS.map((c) => c.toUpperCase());
  for (const ci of [CD.warning, CD.success, CD.danger, mix(CD.blau, 55, CD.schwarz)]) {
    assert.ok(palette.includes(ci.toUpperCase()), `${ci} left the palette — update the comment in contracts/live.ts`);
  }
  // the CI blue is the LOCAL selection — never a peer's colour
  assert.ok(!palette.includes(CD.blau) && !palette.includes(CD.blauLink));
  assert.equal(FALLBACK_PRESENCE_COLOR, CD.textLeise);
  assert.ok(!palette.includes(FALLBACK_PRESENCE_COLOR.toUpperCase()));
  assert.ok(contrast(CD.weiss, FALLBACK_PRESENCE_COLOR) >= 4.5);
  assert.equal(ALIASES.card, CD.weiss); // the canvas the cursors sit on
});

test("remote carets: a peer's selection keeps the syntax colours ≥ 4.5:1, whoever it is", () => {
  // a decoration, so it lands on the peer's line — which is often our current one
  for (const under of [ground, over(color("editor.lineHighlightBackground"), ground)]) {
    for (const peer of PRESENCE_COLORS) {
      const wash = mix(peer, REMOTE_SELECTION_ALPHA * 100, under);
      for (const rule of designiqTheme.rules) {
        if (!rule.foreground) continue;
        const ratio = contrast(rule.foreground, wash);
        assert.ok(ratio >= 4.5, `${rule.token || "default"} under ${peer} on ${under}: ${ratio.toFixed(2)}:1`);
      }
    }
  }
});
