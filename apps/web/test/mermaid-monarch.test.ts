/**
 * The Mermaid grammar of the Markdown source (lib/mermaid-monarch.ts) and its
 * registration (lib/monaco-languages.ts), run through Monaco's OWN Monarch
 * engine: the editor's entry needs a DOM, but the Monarch compiler and lexer,
 * the Markdown grammar and the base theme are plain modules that load under
 * node (monaco-editor's exact pin: a bump that moves them fails here first).
 * Every sample is tokenized the way the editor tokenizes it, a ```mermaid
 * fence inside a Markdown document included.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";

import { MERMAID_DIAGRAM_TYPES } from "@designiq/notations/mermaid";
import type { editor, languages } from "monaco-editor";

import { conf, language } from "../src/lib/mermaid-monarch.ts";
import { installMonacoLanguages, type MonacoLanguagesApi } from "../src/lib/monaco-languages.ts";
import { designiqTheme } from "../src/lib/monaco-theme.ts";

/** a module of Monaco's own: plain ES modules without typings (a computed
 *  specifier, so tsc looks for none), typed by the slice used here */
const monacoModule = async <T>(path: string): Promise<T> => (await import(`monaco-editor/esm/vs/${path}`)) as T;

interface MonarchState {
  stack: { depth: number; state: string };
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

/** the languages the lexer asked Monaco to bring their basic features for */
const requested: string[] = [];
let mermaid: Tokenizer;
let markdown: Tokenizer;

before(async () => {
  installMonacoLanguages(api);
  installMonacoLanguages(api);
  const [{ compile }, { MonarchTokenizer }, { TokenizationRegistry }, markdownGrammar] = await Promise.all([
    monacoModule<{ compile(id: string, json: languages.IMonarchLanguage): unknown }>(
      "editor/standalone/common/monarch/monarchCompile.js",
    ),
    monacoModule<{ MonarchTokenizer: TokenizerClass }>("editor/standalone/common/monarch/monarchLexer.js"),
    monacoModule<{ TokenizationRegistry: { register(id: string, support: Tokenizer): unknown } }>(
      "editor/common/languages.js",
    ),
    monacoModule<{ language: languages.IMonarchLanguage }>("basic-languages/markdown/markdown.js"),
  ]);
  // Monaco's language service as the lexer asks it: a fence's word resolves
  // through the registered names, case aside
  const ids = new Map([["markdown", "markdown"]]);
  for (const entry of registered) {
    for (const name of [entry.id, ...(entry.aliases ?? [])]) ids.set(name.toLowerCase(), entry.id);
  }
  const languageService = {
    languageIdCodec: { encodeLanguageId: () => 0 },
    getLanguageIdByLanguageName: (name: string) => ids.get(name.toLowerCase()) ?? null,
    getLanguageIdByMimeType: () => null,
    isRegisteredLanguageId: (id: string) => [...ids.values()].includes(id),
    requestBasicLanguageFeatures: (id: string) => void requested.push(id),
  };
  const themeService = { getColorTheme: () => ({ tokenTheme: null }) };
  const configurationService = { getValue: () => 20_000, onDidChangeConfiguration: () => disposable };
  const tokenizer = (id: string, grammar: languages.IMonarchLanguage): Tokenizer =>
    new MonarchTokenizer(languageService, themeService, id, compile(id, grammar), configurationService);
  // the grammar as Monaco gets it: through the registered factory
  mermaid = tokenizer("mermaid", (await factories.get("mermaid")?.create()) as languages.IMonarchLanguage);
  TokenizationRegistry.register("mermaid", mermaid);
  markdown = tokenizer("markdown", markdownGrammar.language);
});

/** a source's lines, each a list of its tokens as Monaco emits them (the
 *  blanks between them dropped) */
function tokenize(tokenizer: Tokenizer, source: string): { text: string; type: string; language: string }[][] {
  let state = tokenizer.getInitialState();
  return source.split("\n").map((line) => {
    const { tokens, endState } = tokenizer.tokenize(line, true, state);
    state = endState;
    return tokens
      .map((t, i) => ({ ...t, text: line.slice(t.offset, tokens[i + 1]?.offset ?? line.length).trim() }))
      .filter((t) => t.text !== "");
  });
}

/** the classes, shortened: the rest are spelled out, ‹› is the default */
const CODES: Record<string, string> = {
  keyword: "K",
  operator: "O",
  constant: "C",
  variable: "V",
  type: "T",
  "attribute.name": "A",
  string: "S",
  number: "N",
  delimiter: "D",
  "delimiter.bracket": "B",
};

/** a diagram's lines, each token as `text‹class›`: `A[Start]` reads `A‹V› [‹B› Start‹S› ]‹B›` */
const diagram = (source: string): string[] =>
  tokenize(mermaid, source).map((line) =>
    line
      .map(({ text, type }) => {
        const name = type.replace(/\.mermaid$/, "");
        return `${text}‹${CODES[name] ?? name}›`;
      })
      .join(" "),
  );

test("registration: Monaco's own lazy pattern for its languages, once per page", async () => {
  assert.deepEqual(registered, [{ id: "mermaid", aliases: ["Mermaid", "mermaid"] }]);
  assert.deepEqual([...factories.keys()], ["mermaid"]);
  // the factory loads the grammar; the language configuration waits for the
  // first fence Monaco meets (onLanguageEncountered: a fence is no model, so
  // onLanguage would never fire)
  assert.equal(await factories.get("mermaid")?.create(), language);
  assert.equal(configured.size, 0);
  encountered.get("mermaid")?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(configured.get("mermaid"), conf);
  assert.deepEqual(conf.comments, { lineComment: "%%" });
  assert.deepEqual(
    conf.brackets?.map((pair) => pair.join("")),
    ["{}", "[]", "()"],
  );
  // auto-closing is Markdown's in a fence: Monaco reads it in the model's language
  assert.equal(conf.autoClosingPairs, undefined);
});

test("a ```mermaid fence of a Markdown document is highlighted as Mermaid, a ~~~ fence is not", () => {
  const doc = [
    "# Order to cash",
    "```mermaid",
    "flowchart LR",
    '  A["open', // a string its fence never closes
    "```",
    "```Mermaid",
    "sequenceDiagram", // a fresh diagram, not the string above
    "```",
    "~~~mermaid",
    "flowchart LR",
    "~~~",
    "````mermaid",
    "flowchart LR",
    "````",
  ].join("\n");
  const lines = tokenize(markdown, doc).map((line) => line.map((t) => `${t.text}‹${t.type}›${t.language}`).join(" "));
  assert.deepEqual(lines.slice(1, 8), [
    "```mermaid‹string.md›markdown",
    "flowchart‹keyword.mermaid›mermaid LR‹constant.mermaid›mermaid",
    'A‹variable.mermaid›mermaid [‹delimiter.bracket.mermaid›mermaid "open‹string.mermaid›mermaid',
    "```‹string.md›markdown",
    "```Mermaid‹string.md›markdown",
    "sequenceDiagram‹keyword.mermaid›mermaid",
    "```‹string.md›markdown",
  ]);
  // Monaco's Markdown grammar embeds the language of a fence of three
  // backticks only
  assert.equal(lines[9], "flowchart LR‹variable.source.md›markdown");
  assert.equal(lines[12], "flowchart LR‹›markdown");
  // meeting the fence asks for the language's basic features: the hook its
  // language configuration hangs on
  assert.ok(requested.includes("mermaid"));
});

test("every diagram type is a header keyword, and opens its family", () => {
  for (const type of MERMAID_DIAGRAM_TYPES) {
    assert.deepEqual(diagram(type), [`${type}‹K›`], type);
    assert.deepEqual(diagram(`  ${type} ;`), [`${type}‹K› ;‹D›`], type);
  }
  // the families' header lists name only types the validator knows
  const families = Object.entries(language).filter(([key]) => key.endsWith("Headers"));
  assert.ok(families.length >= 10);
  for (const [family, headers] of families) {
    for (const header of headers as string[]) assert.ok(MERMAID_DIAGRAM_TYPES.includes(header), `${family}: ${header}`);
  }
  // -v2 and -beta forms read on in their family
  assert.deepEqual(diagram("classDiagram-v2\n  Animal <|-- Duck"), ["classDiagram-v2‹K›", "Animal‹V› <|--‹O› Duck‹V›"]);
  assert.deepEqual(diagram("stateDiagram-v2\n  [*] --> Still"), ["stateDiagram-v2‹K›", "[*]‹C› -->‹O› Still‹V›"]);
  assert.deepEqual(diagram("xychart-beta horizontal"), ["xychart-beta‹K› horizontal‹K›"]);
});

test("a first word that names no diagram is invalid, as the validator warns, and the rest still reads", () => {
  assert.deepEqual(diagram("flowchar LR\n  A --> B"), ["flowchar‹invalid› LR‹C›", "A‹V› -->‹O› B‹V›"]);
  // Mermaid's header is case-sensitive, and so is the validator's
  assert.deepEqual(diagram("Flowchart LR"), ["Flowchart‹invalid› LR‹C›"]);
  assert.deepEqual(diagram("graph-beta TD"), ["graph-beta‹invalid› TD‹C›"]);
});

test("comments, directives and the fence's own front matter", () => {
  assert.deepEqual(
    diagram(
      [
        "---",
        "title: Order flow # the title",
        "config:",
        "  theme: forest",
        "  flowchart:",
        "    padding: 15",
        "  - listed",
        "---",
        "%%{init: {'theme': 'base', \"look\": true}}%%",
        "%%{init: {",
        '  "flowchart": { "htmlLabels": false } } }%%',
        "flowchart LR",
        "  %% a comment on its own line",
        "  A --> B %% inline: Mermaid reads it as text",
        "  %%{wrap}%%",
      ].join("\n"),
    ),
    [
      "---‹metatag›",
      "title‹T› :‹D› Order‹S› flow‹S› # the title‹comment›",
      "config‹T› :‹D›",
      "theme‹T› :‹D› forest‹S›",
      "flowchart‹T› :‹D›",
      "padding‹T› :‹D› 15‹N›",
      "-‹D› listed‹S›",
      "---‹metatag›",
      "%%{‹annotation› init‹K› :‹D› {‹B› 'theme'‹T› :‹D› 'base'‹S› ,‹D› \"look\"‹T› :‹D› true‹K› }‹B› }%%‹annotation›",
      "%%{‹annotation› init‹K› :‹D› {‹B›",
      '"flowchart"‹T› :‹D› {‹B› "htmlLabels"‹T› :‹D› false‹K› }‹B› }‹B› }%%‹annotation›',
      "flowchart‹K› LR‹C›",
      "%% a comment on its own line‹comment›",
      "A‹V› -->‹O› B‹V› %%‹› inline‹V› :‹D› Mermaid‹V› reads‹V› it‹V› as‹V› text‹V›",
      "%%{‹annotation› wrap‹K› }%%‹annotation›",
    ],
  );
});

test("flowchart: nodes and their shapes, links and their labels, subgraphs, styles", () => {
  assert.deepEqual(
    diagram(
      [
        "flowchart TD",
        "  A[Start] --> B{Is it?}",
        "  B -->|Yes| C([OK]) & D[(Store)]",
        "  B -- no --> E[[Rethink]]",
        "  C -. maybe .-> F((End)) ==> G>Flag]",
        "  D == sure ==> H{{Hex}} --o I[/In/] --x J[\\Out\\] <--> K(((Stop)))",
        "  my-node --- other-node ~~~ x-ray",
        '  A@{ shape: rect, label: "Start" } e1@--> B',
        '  subgraph one ["Title one"]',
        "    direction LR",
        "  end",
        '  click A href "https://example.com" _blank',
        "  style A fill:#f9f,stroke-width:4px",
        "  linkStyle 0,1 stroke:#ff3",
        "  classDef default fill:#fff;",
        "  A:::green --> B",
        "  Subgraph X",
      ].join("\n"),
    ),
    [
      "flowchart‹K› TD‹C›",
      "A‹V› [‹B› Start‹S› ]‹B› -->‹O› B‹V› {‹B› Is it?‹S› }‹B›",
      "B‹V› -->‹O› |‹D› Yes‹S› |‹D› C‹V› ([‹B› OK‹S› ])‹B› &‹O› D‹V› [(‹B› Store‹S› )]‹B›",
      "B‹V› --‹O› no‹S› -->‹O› E‹V› [[‹B› Rethink‹S› ]]‹B›",
      "C‹V› -.‹O› maybe‹S› .->‹O› F‹V› ((‹B› End‹S› ))‹B› ==>‹O› G‹V› >‹B› Flag‹S› ]‹B›",
      "D‹V› ==‹O› sure‹S› ==>‹O› H‹V› {{‹B› Hex‹S› }}‹B› --o‹O› I‹V› [/‹B› In‹S› /]‹B› --x‹O› J‹V› [\\‹B› Out‹S› \\]‹B› <-->‹O› K‹V› (((‹B› Stop‹S› )))‹B›",
      "my-node‹V› ---‹O› other-node‹V› ~~~‹O› x-ray‹V›",
      'A‹V› @{‹B› shape‹T› :‹D› rect‹S› ,‹D› label‹T› :‹D› "Start"‹S› }‹B› e1‹V› @‹› -->‹O› B‹V›',
      'subgraph‹K› one‹V› [‹B› "Title one"‹S› ]‹B›',
      "direction‹K› LR‹C›",
      "end‹K›",
      'click‹K› A‹V› href‹K› "https://example.com"‹S› _blank‹C›',
      "style‹K› A‹V› fill‹A› :‹D› #f9f‹N› ,‹D› stroke-width‹A› :‹D› 4px‹N›",
      "linkStyle‹K› 0,1‹N› stroke‹A› :‹D› #ff3‹N›",
      "classDef‹K› default‹K› fill‹A› :‹D› #fff‹N› ;‹D›",
      // the style line's state ended with its line
      "A‹V› :::‹O› green‹V› -->‹O› B‹V›",
      // flowchart keywords keep Mermaid's case
      "Subgraph‹V› X‹V›",
    ],
  );
  // a dotted link's text may hold a hyphen, never the next link's -.
  assert.deepEqual(diagram("flowchart LR\n  A -. x-ray - b .-> B -. on .- C"), [
    "flowchart‹K› LR‹C›",
    "A‹V› -.‹O› x-ray - b‹S› .->‹O› B‹V› -.‹O› on‹S› .-‹O› C‹V›",
  ]);
});

test("flowchart: a quoted text and an open shape run on over the line break", () => {
  assert.deepEqual(
    diagram(["flowchart LR", '  A["two', '  lines"] --> B[open', "  still text]", "  C --> D"].join("\n")),
    [
      "flowchart‹K› LR‹C›",
      'A‹V› [‹B› "two‹S›',
      'lines"‹S› ]‹B› -->‹O› B‹V› [‹B› open‹S›',
      "still text‹S› ]‹B›",
      "C‹V› -->‹O› D‹V›",
    ],
  );
});

test("sequence: participants, messages, blocks and notes, in any case", () => {
  assert.deepEqual(
    diagram(
      [
        "sequenceDiagram",
        "  autonumber",
        "  participant A as Alice Smith",
        "  actor B",
        "  A->>+B: Hello Bob, how are you?",
        "  B-->>-A:Fine",
        "  A-)B: async",
        "  A-xB: lost",
        "  A<<->>B: both ways",
        "  loop Every minute",
        "  alt is sick",
        "  else is well",
        "  par Alice to Bob",
        "  and Alice to John",
        "  critical Establish a connection",
        "  break when the booking fails",
        "  rect rgb(191, 223, 255)",
        "  end",
        "  NOTE right of A: Text in note",
        "  Note over A,B: A typical interaction",
        "  Deactivate A",
      ].join("\n"),
    ),
    [
      "sequenceDiagram‹K›",
      "autonumber‹K›",
      "participant‹K› A‹V› as‹K› Alice Smith‹S›",
      "actor‹K› B‹V›",
      "A‹V› ->>+‹O› B‹V› :‹D› Hello Bob, how are you?‹S›",
      "B‹V› -->>-‹O› A‹V› :‹D› Fine‹S›",
      "A‹V› -)‹O› B‹V› :‹D› async‹S›",
      "A‹V› -x‹O› B‹V› :‹D› lost‹S›",
      "A‹V› <<->>‹O› B‹V› :‹D› both ways‹S›",
      "loop‹K› Every minute‹S›",
      "alt‹K› is sick‹S›",
      "else‹K› is well‹S›",
      "par‹K› Alice to Bob‹S›",
      "and‹K› Alice to John‹S›",
      "critical‹K› Establish a connection‹S›",
      "break‹K› when the booking fails‹S›",
      "rect‹K› rgb‹V› (‹B› 191‹N› ,‹D› 223‹N› ,‹D› 255‹N› )‹B›",
      "end‹K›",
      "NOTE‹K› right of‹K› A‹V› :‹D› Text in note‹S›",
      "Note‹K› over‹K› A‹V› ,‹D› B‹V› :‹D› A typical interaction‹S›",
      "Deactivate‹K› A‹V›",
    ],
  );
});

test("class: relations, members, stereotypes, notes", () => {
  assert.deepEqual(
    diagram(
      [
        "classDiagram",
        "  direction RL",
        "  Animal <|-- Duck",
        "  Duck *-- Egg : lays",
        "  Duck o-- Pond",
        "  Duck ..|> Swimmer",
        '  Duck "1" --> "*" Feather',
        "  class Duck {",
        "    +String beak",
        "    -swim() void",
        "  }",
        "  <<interface>> Swimmer",
        '  note for Duck "can fly"',
        "  oak --> elm",
      ].join("\n"),
    ),
    [
      "classDiagram‹K›",
      "direction‹K› RL‹C›",
      "Animal‹V› <|--‹O› Duck‹V›",
      "Duck‹V› *--‹O› Egg‹V› :‹D› lays‹S›",
      "Duck‹V› o--‹O› Pond‹V›",
      "Duck‹V› ..|>‹O› Swimmer‹V›",
      'Duck‹V› "1"‹S› -->‹O› "*"‹S› Feather‹V›',
      "class‹K› Duck‹V› {‹B›",
      "+‹O› String‹V› beak‹V›",
      "-‹O› swim‹V› ()‹B› void‹V›",
      "}‹B›",
      "<<interface>>‹annotation› Swimmer‹V›",
      'note for‹K› Duck‹V› "can fly"‹S›',
      "oak‹V› -->‹O› elm‹V›",
    ],
  );
});

test("state: [*], composites, forks, notes on lines of their own", () => {
  assert.deepEqual(
    diagram(
      [
        "stateDiagram-v2",
        "  [*] --> Still : starts",
        '  STATE "Long name" as s3',
        "  state fork_state <<fork>>",
        "  state Comp {",
        "    --",
        "  }",
        "  note right of Still",
        "    two lines",
        "    of note text",
        "  end note",
        "  note left of s3 : one line",
        "  Still:::hot --> [*]",
      ].join("\n"),
    ),
    [
      "stateDiagram-v2‹K›",
      "[*]‹C› -->‹O› Still‹V› :‹D› starts‹S›",
      'STATE‹K› "Long name"‹S› as‹K› s3‹V›',
      "state‹K› fork_state‹V› <<fork>>‹annotation›",
      "state‹K› Comp‹V› {‹B›",
      "--‹O›",
      "}‹B›",
      "note‹K› right of‹K› Still‹V›",
      "two lines‹S›",
      "of note text‹S›",
      "end note‹K›",
      "note‹K› left of‹K› s3‹V› :‹D› one line‹S›",
      "Still‹V› :::‹O› hot‹V› -->‹O› [*]‹C›",
    ],
  );
});

test("ER: relationship cardinalities, keys, hyphenated entities", () => {
  assert.deepEqual(
    diagram(
      [
        "erDiagram",
        "  CUSTOMER ||--o{ ORDER : places",
        "  ORDER ||--|{ LINE-ITEM : contains",
        '  CUSTOMER }|..|{ DELIVERY-ADDRESS : "uses"',
        "  PERSON |o--o| CAR : drives",
        "  CAR one or more to zero or many DRIVER : allows",
        "  CUSTOMER {",
        '    string name PK "the name"',
        "    string email uk",
        "  }",
      ].join("\n"),
    ),
    [
      "erDiagram‹K›",
      "CUSTOMER‹V› ||--o{‹O› ORDER‹V› :‹D› places‹S›",
      "ORDER‹V› ||--|{‹O› LINE-ITEM‹V› :‹D› contains‹S›",
      'CUSTOMER‹V› }|..|{‹O› DELIVERY-ADDRESS‹V› :‹D› "uses"‹S›',
      "PERSON‹V› |o--o|‹O› CAR‹V› :‹D› drives‹S›",
      "CAR‹V› one or more‹O› to‹O› zero or many‹O› DRIVER‹V› :‹D› allows‹S›",
      "CUSTOMER‹V› {‹B›",
      'string‹V› name‹V› PK‹K› "the name"‹S›',
      "string‹V› email‹V› uk‹K›",
      "}‹B›",
    ],
  );
});

test("gantt: settings, sections, tasks and their data", () => {
  assert.deepEqual(
    diagram(
      [
        "gantt",
        "  title A Gantt Diagram",
        "  dateFormat YYYY-MM-DD",
        "  excludes weekends",
        "  section Design",
        "  A task :a1, 2014-01-01, 30d",
        "  Another task :after a1, 20d",
        "  Done one :done, crit, des1, 2014-01-06T09:00, 24h",
        '  click a1 href "https://example.com"',
        "  inclusiveEndDates",
      ].join("\n"),
    ),
    [
      "gantt‹K›",
      "title‹K› A Gantt Diagram‹S›",
      "dateFormat‹K› YYYY-MM-DD‹S›",
      "excludes‹K› weekends‹S›",
      "section‹K› Design‹S›",
      "A task‹S› :‹D› a1‹V› ,‹D› 2014-01-01‹N› ,‹D› 30d‹N›",
      "Another task‹S› :‹D› after‹K› a1‹V› ,‹D› 20d‹N›",
      "Done one‹S› :‹D› done‹K› ,‹D› crit‹K› ,‹D› des1‹V› ,‹D› 2014-01-06T09:00‹N› ,‹D› 24h‹N›",
      'click‹K› a1‹V› href‹K› "https://example.com"‹S›',
      "inclusiveEndDates‹K›",
    ],
  );
});

test("C4: elements, boundaries, relations and their $parameters", () => {
  assert.deepEqual(
    diagram(
      [
        "C4Context",
        "  title System Context",
        '  Person(customerA, "Banking Customer A", "A customer")',
        '  Enterprise_Boundary(b1, "Bank") {',
        '    SystemDb_Ext(mainframe, "Mainframe")',
        "  }",
        '  Rel(customerA, mainframe, "Uses")',
        '  UpdateRelStyle(customerA, mainframe, $textColor="blue")',
      ].join("\n"),
    ),
    [
      "C4Context‹K›",
      "title‹K› System Context‹S›",
      'Person‹K› (‹B› customerA‹V› ,‹D› "Banking Customer A"‹S› ,‹D› "A customer"‹S› )‹B›',
      'Enterprise_Boundary‹K› (‹B› b1‹V› ,‹D› "Bank"‹S› )‹B› {‹B›',
      'SystemDb_Ext‹K› (‹B› mainframe‹V› ,‹D› "Mainframe"‹S› )‹B›',
      "}‹B›",
      'Rel‹K› (‹B› customerA‹V› ,‹D› mainframe‹V› ,‹D› "Uses"‹S› )‹B›',
      'UpdateRelStyle‹K› (‹B› customerA‹V› ,‹D› mainframe‹V› ,‹D› $textColor‹A› =‹O› "blue"‹S› )‹B›',
    ],
  );
});

test("the other families: their words, numbers, strings and arrows", () => {
  assert.deepEqual(diagram('pie showData\n  "Calcium" : 42.96'), ["pie‹K› showData‹K›", '"Calcium"‹S› :‹D› 42.96‹N›']);
  assert.deepEqual(diagram('gitGraph LR:\n  commit id: "1" type: HIGHLIGHT\n  cherry-pick id: "1"'), [
    "gitGraph‹K› LR‹C› :‹D›",
    'commit‹K› id‹K› :‹D› "1"‹S› type‹K› :‹D› HIGHLIGHT‹C›',
    'cherry-pick‹K› id‹K› :‹D› "1"‹S›',
  ]);
  assert.deepEqual(diagram('xychart-beta\n  y-axis "Revenue" 4000 --> 11000\n  quadrant-1 We should expand'), [
    "xychart-beta‹K›",
    'y-axis‹K› "Revenue"‹S› 4000‹N› -->‹O› 11000‹N›',
    "quadrant-1‹K› We should expand‹S›",
  ]);
  assert.deepEqual(diagram("requirementDiagram\n  text: the test text.\n  a - satisfies -> b"), [
    "requirementDiagram‹K›",
    "text‹K› :‹D› the test text.‹S›",
    "a‹V› -‹O› satisfies‹K› ->‹O› b‹V›",
  ]);
  assert.deepEqual(diagram("journey\n  section Go to work\n  Make tea: 5: Me"), [
    "journey‹K›",
    "section‹K› Go to work‹S›",
    "Make‹V› tea‹V› :‹D› 5‹N› :‹D› Me‹V›",
  ]);
  assert.deepEqual(diagram("mindmap\n  root((Mind map))"), ["mindmap‹K›", "root‹V› ((‹B› Mind‹V› map‹V› ))‹B›"]);
});

/** every token class the grammar's rules can emit */
function emittedTokens(grammar: languages.IMonarchLanguage): Set<string> {
  const names = new Set<string>([grammar.defaultToken ?? "source"]);
  const visit = (action: unknown): void => {
    if (typeof action === "string") names.add(action);
    else if (Array.isArray(action)) for (const each of action) visit(each);
    else if (action && typeof action === "object") {
      const { token, cases } = action as { token?: string; cases?: Record<string, unknown> };
      if (token !== undefined) names.add(token);
      if (cases) for (const each of Object.values(cases)) visit(each);
    }
  };
  for (const rules of Object.values(grammar.tokenizer)) {
    for (const rule of rules) visit(Array.isArray(rule) ? rule[1] : "action" in rule ? rule.action : undefined);
  }
  return names;
}

test("every token class has a rule of the designiq theme, on the roles it already has", async () => {
  const { vs } = await monacoModule<{ vs: editor.IStandaloneThemeData }>("editor/standalone/common/themes.js");
  const ours = new Map(designiqTheme.rules.map((rule) => [rule.token, rule]));
  const base = new Set(vs.rules.map((rule) => rule.token));
  const names = emittedTokens(language);
  assert.ok(names.has("") && names.has("operator") && names.has("invalid"));
  for (const name of names) {
    assert.ok(!name.startsWith("@"), name);
    if (name === "") continue; // the theme's default rule
    // Monaco's theme match: the deepest dot-prefix with a rule decides, the
    // theme's own rule over the inherited vs one at the same depth
    const segments = `${name}${language.tokenPostfix}`.split(".");
    const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join("."));
    const deepest = prefixes.filter((prefix) => ours.has(prefix) || base.has(prefix)).at(-1);
    assert.ok(deepest && ours.get(deepest)?.foreground, `${name} falls to ${deepest ?? "the default"}`);
  }
  // the one rule the grammar added draws in a colour the theme had: the
  // structure's, on Mermaid's operators alone (a bare rule would recolour a
  // ```rust fence's too)
  assert.equal(ours.get("operator.mermaid")?.foreground, ours.get("keyword")?.foreground);
  assert.ok(!ours.has("operator"));
});

test("odd text never throws, always moves on, never stacks up", () => {
  let seed = 7;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n);
  };
  const pieces = [
    ...`-.=>|<ox[](){}"':;#@*/\\~&\`$+%^!?,`,
    "--",
    "-->",
    "%%",
    "%%{",
    "}%%",
    "@{",
    "---",
    "[*]",
    " ",
    "  ",
    "A",
    "b-c",
    "note",
    "left of",
    "end",
    "end note",
    "style",
    "classDef",
    "1",
    "2014-01-01",
    "#fff",
    "é",
    "注文",
  ];
  // every family's first header, a type Mermaid does not know, none at all
  const headers = [
    ...Object.entries(language)
      .filter(([key]) => key.endsWith("Headers"))
      .map(([, list]) => (list as string[])[0] ?? "pie"),
    "nonsense",
    "",
  ];
  let lines = 0;
  for (const header of headers) {
    for (let run = 0; run < 60; run++) {
      const body = Array.from({ length: 1 + random(6) }, () =>
        Array.from({ length: random(14) }, () => pieces[random(pieces.length)]).join(""),
      );
      let state = mermaid.getInitialState();
      for (const line of [header, ...body]) {
        const { tokens, endState } = mermaid.tokenize(line, true, state);
        const offsets = tokens.map((t) => t.offset);
        assert.ok(
          offsets.every((at, i) => at >= 0 && at < Math.max(line.length, 1) && (i === 0 || at > offsets[i - 1]!)),
          JSON.stringify(line),
        );
        assert.ok(endState.stack.depth <= 3, `${JSON.stringify(line)}: ${endState.stack.state}`);
        state = endState;
        lines++;
      }
    }
  }
  assert.ok(lines > 2000, `${lines} lines`);
});

test("long and odd lines finish at once: no pattern backtracks out of hand", () => {
  // up to Monaco's tokenization limit (20 000 characters). Each line is read
  // at its full length and at an eighth of it, the best of three from the
  // state the line before left: a linear read takes about eight times as
  // long, a pattern gone quadratic about 64 times (a dotted link's text read
  // on from every -. to the line's end). A ratio, not a budget in ms, so a
  // slow or busy CI runner does not fail a linear grammar. A line over the
  // bound is read again, up to three rounds: the suites running alongside
  // can stall a single read past the bound, a quadratic pattern exceeds it
  // in every round
  const long: Array<(n: number) => string> = [
    (n) => `A -- ${"x ".repeat(n)}`,
    (n) => "-- x ".repeat(n),
    (n) => "== x ".repeat(n),
    (n) => "-. x ".repeat(n),
    (n) => ".".repeat(n),
    (n) => `${"-".repeat(n)}a`,
    (n) => `a${" ".repeat(n)}`,
    (n) => `"${"a ".repeat(n)}`,
    (n) => `A[${"b".repeat(n)}`,
    (n) => `${"a ".repeat(n)}:`,
    (n) => "<<a".repeat(n),
    (n) => "|a".repeat(n),
    (n) => `%%{${'"a": '.repeat(n)}`,
  ];
  type State = Parameters<typeof mermaid.tokenize>[2];
  const timed = (line: string, state: State): number => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      mermaid.tokenize(line, true, state);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  // every family's first header
  const headers = Object.entries(language)
    .filter(([key]) => key.endsWith("Headers"))
    .map(([, list]) => (list as string[])[0] ?? "pie");
  for (const header of headers) {
    let state = mermaid.tokenize(header, true, mermaid.getInitialState()).endState;
    for (const make of long) {
      const unit = make(1).length;
      const n = Math.floor(19_000 / unit);
      const line = make(n);
      const short = make(Math.floor(n / 8));
      // a floor for lines too fast to time: well under a quadratic read of 19 000 characters
      const withinBound = (full: number, eighth: number): boolean => full < Math.max(24 * eighth, 10);
      let full = Infinity;
      let eighth = Infinity;
      for (let round = 0; round < 3 && !withinBound(full, eighth); round++) {
        full = Math.min(full, timed(line, state));
        eighth = Math.min(eighth, timed(short, state));
      }
      assert.ok(
        withinBound(full, eighth),
        `${header}, ${JSON.stringify(line.slice(0, 10))}…: ${full.toFixed(1)} ms in full, ${eighth.toFixed(1)} ms at an eighth`,
      );
      state = mermaid.tokenize(line, true, state).endState;
    }
  }
});
