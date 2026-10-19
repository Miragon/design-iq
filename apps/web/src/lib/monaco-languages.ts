/**
 * The languages designIQ adds to Monaco's own: so far `mermaid`, for the
 * ```mermaid fences of a Markdown source (Monaco's Markdown grammar hands a
 * backtick fence to the language its info word names, once that language is
 * registered; lib/mermaid-monarch.ts has the grammar).
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
 * language arrives. Only the id and two closures are eager; the grammar, and
 * the diagram types it is built from, are a chunk of their own (ADR 0006,
 * `pnpm arch` rule mermaid-grammar-loads-lazily). The call sits next to the
 * createModel calls it must precede, so no model can come first.
 *
 * Monaco is a parameter, as in monaco-theme.ts: the installer runs under
 * node --test without loading the editor.
 */
import type { languages } from "monaco-editor";

const MERMAID = "mermaid";

/** the slice of `monaco.languages` the installer touches */
export type MonacoLanguagesApi = Pick<
  typeof languages,
  "register" | "registerTokensProviderFactory" | "onLanguageEncountered" | "setLanguageConfiguration"
>;

const loadMermaid = () => import("./mermaid-monarch.ts");

let installed = false;

/** Register the languages once per page; repeat calls are no-ops. */
export function installMonacoLanguages(api: MonacoLanguagesApi): void {
  if (installed) return;
  installed = true;
  api.register({ id: MERMAID, aliases: ["Mermaid", MERMAID] });
  api.registerTokensProviderFactory(MERMAID, { create: async () => (await loadMermaid()).language });
  api.onLanguageEncountered(MERMAID, () => {
    void loadMermaid().then(
      ({ conf }) => api.setLanguageConfiguration(MERMAID, conf),
      () => {
        /* the chunk did not load: the fence keeps Monaco's plain editing */
      },
    );
  });
}
