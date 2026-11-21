/**
 * The languages designIQ adds to Monaco's own:
 *
 *   mermaid  the ```mermaid fences of a Markdown source (Monaco's Markdown
 *            grammar hands a backtick fence to the language its info word
 *            names, once that language is registered; lib/mermaid-monarch.ts
 *            has the grammar)
 *   jsonl    JSON lines, the text a structured document (a board) is saved
 *            as: its read-only source and its History diff
 *            (lib/jsonl-monarch.ts; the notation's descriptor names it)
 *
 * Monaco's own pattern for its basic languages (basic-languages/
 * _.contribution.js): the id is registered up front, the grammar loads the
 * first time a line needs it (registerTokensProviderFactory) and the editing
 * rules the first time the language is met (onLanguageEncountered, which
 * fires for an embedded fence too; onLanguage fires only for a MODEL of the
 * language, never for a fence).
 *
 * Install before the first createModel, at every place that makes one (the
 * live editor, the history diff): Monaco's Markdown grammar reads a fence of
 * an unregistered language as plain text, and does not go back once the
 * language arrives, and a model of an unregistered language stays plain
 * text. Only the ids and two closures each are eager; each grammar is a
 * chunk of its own (ADR 0006; the Mermaid one is built from the diagram
 * types, `pnpm arch` rule mermaid-grammar-loads-lazily). The call sits next
 * to the createModel calls it must precede, so no model can come first.
 *
 * Monaco is a parameter, as in monaco-theme.ts: the installer runs under
 * node --test without loading the editor.
 */
import type { languages } from "monaco-editor";

/** the slice of `monaco.languages` the installer touches */
export type MonacoLanguagesApi = Pick<
  typeof languages,
  "register" | "registerTokensProviderFactory" | "onLanguageEncountered" | "setLanguageConfiguration"
>;

/** what a grammar module exports: its Monarch grammar and its editing rules */
interface GrammarModule {
  language: languages.IMonarchLanguage;
  conf: languages.LanguageConfiguration;
}

/** `id` known to Monaco now, its grammar and editing rules loaded when it is first needed */
function registerLazily(
  api: MonacoLanguagesApi,
  id: string,
  aliases: string[],
  load: () => Promise<GrammarModule>,
): void {
  api.register({ id, aliases });
  api.registerTokensProviderFactory(id, { create: async () => (await load()).language });
  api.onLanguageEncountered(id, () => {
    void load().then(
      ({ conf }) => api.setLanguageConfiguration(id, conf),
      () => {
        /* the chunk did not load: the text keeps Monaco's plain editing */
      },
    );
  });
}

let installed = false;

/** Register the languages once per page; repeat calls are no-ops. */
export function installMonacoLanguages(api: MonacoLanguagesApi): void {
  if (installed) return;
  installed = true;
  registerLazily(api, "mermaid", ["Mermaid", "mermaid"], () => import("./mermaid-monarch.ts"));
  registerLazily(api, "jsonl", ["JSON Lines", "jsonl"], () => import("./jsonl-monarch.ts"));
}
