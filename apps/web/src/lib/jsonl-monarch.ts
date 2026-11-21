/**
 * The Monaco language "jsonl": JSON lines, one JSON value per line. It is the
 * text a structured document is saved as (a board: a header line, then one
 * line per element, @designiq/notations/codecs), shown read-only in its
 * source view and in the History diff.
 *
 * Monaco's own JSON language reads a model as ONE value and marks every line
 * after the first ("End of file expected"), and its validation can only be
 * switched off for every JSON model at once (the Team Topology and Value
 * Chain sources keep theirs). This grammar only colours: no validation, no
 * worker.
 *
 * Every rule matches within one line and none changes state, so each line
 * is read on its own and a broken line never colours the next. The token
 * classes are the ones Monaco's JSON tokenizer emits
 * (vs/language/json/tokenization.js): with the ".json" postfix, a JSON line
 * reads in the designiq theme (lib/monaco-theme.ts) exactly as a JSON source
 * does. test/jsonl-monarch.test.ts runs it through Monaco's own Monarch
 * engine and holds the classes to that tokenizer's.
 *
 * Loaded the first time Monaco needs it (lib/monaco-languages.ts).
 */
import type { languages } from "monaco-editor";

export const conf: languages.LanguageConfiguration = {
  // the word a double-click selects: Monaco's JSON one
  wordPattern: /(-?\d*\.\d\w*)|([^[{\]}:",\s]+)/g,
  // bracket matching and the bracket-pair colours (the theme's
  // editorBracketHighlight), as on a JSON source
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
};

export const language: languages.IMonarchLanguage = {
  defaultToken: "invalid",
  tokenPostfix: ".json",
  tokenizer: {
    root: [
      [/\s+/, ""],
      // a property name: a string the colon follows
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key"],
      // a string value; one its line never closes ends with the line
      [/"(?:[^"\\]|\\.)*"?/, "string.value"],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/(?:true|false|null)\b/, "keyword"],
      [/[{}]/, "delimiter.bracket"],
      [/[[\]]/, "delimiter.array"],
      [/:/, "delimiter.colon"],
      [/,/, "delimiter.comma"],
    ],
  },
};
