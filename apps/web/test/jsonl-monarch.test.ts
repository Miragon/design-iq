/**
 * The "jsonl" grammar (lib/jsonl-monarch.ts) of a structured document's
 * read-only source and History diff, and its registration
 * (lib/monaco-languages.ts), run through Monaco's OWN Monarch engine as in
 * test/mermaid-monarch.test.ts: every line of a board's canonical text reads
 * as Monaco's JSON tokenizer reads JSON, each line on its own, and the token
 * classes are that tokenizer's (the designiq theme colours them).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { before, test } from "node:test";

import { docCodecFor } from "@designiq/notations/codecs";
import type { languages } from "monaco-editor";

import { conf, language } from "../src/lib/jsonl-monarch.ts";
import { installMonacoLanguages, type MonacoLanguagesApi } from "../src/lib/monaco-languages.ts";
import { designiqTheme } from "../src/lib/monaco-theme.ts";

const require = createRequire(import.meta.url);

/** a module of Monaco's own: plain ES modules without typings (a computed
 *  specifier, so tsc looks for none), typed by the slice used here */
const monacoModule = async <T>(path: string): Promise<T> => (await import(`monaco-editor/esm/vs/${path}`)) as T;

interface MonarchState {
  stack: { depth: number; state: string };
  equals(other: MonarchState): boolean;
}
interface Tokenizer {
  getInitialState(): MonarchState;
  tokenize(
    line: string,
    hasEOL: boolean,
    state: MonarchState,
  ): { tokens: { offset: number; type: string; language: string }[]; endState: MonarchState };
}
type TokenizerClass = new (
  languageService: object,
  themeService: object,
  languageId: string,
  lexer: unknown,
  configurationService: object,
) => Tokenizer;

// what installMonacoLanguages hands Monaco
const registered: languages.ILanguageExtensionPoint[] = [];
const factories = new Map<string, languages.TokensProviderFactory>();
const encountered = new Map<string, () => void>();
const configured = new Map<string, languages.LanguageConfiguration>();
const disposable = { dispose: () => {} };
const api: MonacoLanguagesApi = {
  register: (entry) => void registered.push(entry),
  registerTokensProviderFactory: (id, factory) => {
    factories.set(id, factory);
    return disposable;
  },
  onLanguageEncountered: (id, callback) => {
    encountered.set(id, callback);
    return disposable;
  },
  setLanguageConfiguration: (id, configuration) => {
    configured.set(id, configuration);
    return disposable;
  },
};

let jsonl: Tokenizer;

before(async () => {
  installMonacoLanguages(api);
  const [{ compile }, { MonarchTokenizer }] = await Promise.all([
    monacoModule<{ compile(id: string, json: languages.IMonarchLanguage): unknown }>(
      "editor/standalone/common/monarch/monarchCompile.js",
    ),
    monacoModule<{ MonarchTokenizer: TokenizerClass }>("editor/standalone/common/monarch/monarchLexer.js"),
  ]);
  const languageService = {
    languageIdCodec: { encodeLanguageId: () => 0 },
    getLanguageIdByLanguageName: () => null,
    getLanguageIdByMimeType: () => null,
    isRegisteredLanguageId: (id: string) => id === "jsonl",
    requestBasicLanguageFeatures: () => {},
  };
  const themeService = { getColorTheme: () => ({ tokenTheme: null }) };
  const configurationService = { getValue: () => 20_000, onDidChangeConfiguration: () => disposable };
  // the grammar as Monaco gets it: through the registered factory
  const grammar = (await factories.get("jsonl")?.create()) as languages.IMonarchLanguage;
  jsonl = new MonarchTokenizer(languageService, themeService, "jsonl", compile("jsonl", grammar), configurationService);
});

/** the classes, shortened: ‹K› a key, ‹S› a string value, the rest spelled out */
const CODES: Record<string, string> = {
  "string.key.json": "K",
  "string.value.json": "S",
  "number.json": "N",
  "keyword.json": "W",
  "delimiter.bracket.json": "{",
  "delimiter.array.json": "[",
  "delimiter.colon.json": ":",
  "delimiter.comma.json": ",",
};

/** a source's lines, each token as `text‹class›` (blanks dropped); each line from the state the one before left */
function lines(source: string): string[] {
  let state = jsonl.getInitialState();
  return source.split("\n").map((line) => {
    const { tokens, endState } = jsonl.tokenize(line, true, state);
    state = endState;
    return tokens
      .map((t, i) => ({ ...t, text: line.slice(t.offset, tokens[i + 1]?.offset ?? line.length).trim() }))
      .filter((t) => t.text !== "")
      .map(({ text, type }) => `${text}‹${CODES[type] ?? type}›`)
      .join(" ");
  });
}

/** every token class the grammar emits for `source` */
function classes(source: string): Set<string> {
  const found = new Set<string>();
  for (const line of source.split("\n")) {
    for (const { type } of jsonl.tokenize(line, true, jsonl.getInitialState()).tokens) if (type) found.add(type);
  }
  return found;
}

const BOARD = docCodecFor("board")!.encode({
  meta: { title: "Workshop", version: 1 },
  elements: {
    n_a: { kind: "node", type: "note", x: 10, y: -20.5, w: 200, h: 100, text: 'Say "hi"\nthen go' },
    n_b: { kind: "node", type: "model", x: 300, y: 20, w: 400, h: 300, file: "processes/order.bpmn" },
    e_1: { kind: "edge", from: "n_a", to: "n_b", label: null, dashed: false, points: [1, 2e3] },
  },
});

test("registration: the id up front, the grammar from its own chunk, the editing rules once the language is met", async () => {
  assert.deepEqual(
    registered.find((entry) => entry.id === "jsonl"),
    { id: "jsonl", aliases: ["JSON Lines", "jsonl"] },
  );
  assert.equal(await factories.get("jsonl")?.create(), language);
  assert.equal(configured.has("jsonl"), false);
  encountered.get("jsonl")?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(configured.get("jsonl"), conf);
  assert.deepEqual(
    conf.brackets?.map((pair) => pair.join("")),
    ["{}", "[]"],
  );
  // read-only text: no comments, nothing typed to close
  assert.equal(conf.comments, undefined);
  assert.equal(conf.autoClosingPairs, undefined);
});

test("a board's canonical text reads as JSON, line by line: keys, strings, numbers, keywords, delimiters", () => {
  const [header, edge, note, model, end] = lines(BOARD);
  assert.equal(
    header,
    '{‹{› "format"‹K› :‹:› "structured-model"‹S› ,‹,› "meta"‹K› :‹:› {‹{› "title"‹K› :‹:› "Workshop"‹S› ,‹,› ' +
      '"version"‹K› :‹:› 1‹N› }‹{› ,‹,› "version"‹K› :‹:› 1‹N› }‹{›',
  );
  assert.equal(
    edge,
    '{‹{› "dashed"‹K› :‹:› false‹W› ,‹,› "from"‹K› :‹:› "n_a"‹S› ,‹,› "id"‹K› :‹:› "e_1"‹S› ,‹,› "kind"‹K› :‹:› ' +
      '"edge"‹S› ,‹,› "label"‹K› :‹:› null‹W› ,‹,› "points"‹K› :‹:› [‹[› 1‹N› ,‹,› 2000‹N› ]‹[› ,‹,› "to"‹K› :‹:› ' +
      '"n_b"‹S› }‹{›',
  );
  // an escaped quote and an escaped line break stay inside their string
  assert.match(note!, /"text"‹K› :‹:› "Say \\"hi\\"\\nthen go"‹S›/);
  assert.match(note!, /"y"‹K› :‹:› -20\.5‹N›/);
  assert.match(model!, /"file"‹K› :‹:› "processes\/order\.bpmn"‹S›/);
  assert.equal(end, "", "the closing line break");
});

test("each line is read on its own: a broken line never colours the next", () => {
  const good = '{"id":"n_a","kind":"node"}';
  const alone = lines(good)[0];
  for (const broken of ['{"id":"n_a","text":"never closed', "not json at all", '{"id":', "}}]],::"]) {
    const [first, second] = lines(`${broken}\n${good}`);
    assert.ok(first !== undefined, broken);
    assert.equal(second, alone, broken);
  }
  // no state is carried at all: every line ends where it began
  let state = jsonl.getInitialState();
  for (const line of BOARD.split("\n")) {
    state = jsonl.tokenize(line, true, state).endState;
    assert.ok(state.equals(jsonl.getInitialState()), line);
  }
  // what is no JSON reads as invalid, the one class the theme colours red
  assert.equal(lines("{tru}")[0], "{‹{› tru‹invalid.json› }‹{›");
});

test("the token classes are the ones Monaco's JSON tokenizer emits, so a JSON line wears the JSON colours", () => {
  const source = readFileSync(require.resolve("monaco-editor/esm/vs/language/json/tokenization.js"), "utf8");
  const json = new Set([...source.matchAll(/const TOKEN_\w+ = "([^"]+)"/g)].map((m) => m[1]!));
  assert.ok(json.has("string.key.json"), [...json].join(", "));
  const emitted = classes(`${BOARD}\n[true, null, 1.5e-3, "x"]`);
  assert.deepEqual(
    [...emitted].filter((type) => !json.has(type)),
    [],
    "a class Monaco's JSON does not have would miss the theme's JSON rules",
  );
  // the theme names the JSON classes it recolours, which a jsonl line now meets
  const themed = new Set(designiqTheme.rules.map((rule) => rule.token));
  for (const type of ["string.key.json", "string.value.json", "keyword.json"]) {
    assert.ok(emitted.has(type), type);
    assert.ok(themed.has(type), type);
  }
});
