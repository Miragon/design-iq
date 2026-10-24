/**
 * Every Mermaid header keyword in other casings (#283), shared by the check
 * against the pinned mermaid (mermaid-engine.test.ts) and the one against
 * the source editor's grammar (mermaid-monarch.test.ts): both hold their
 * reader to the validator's on the same spellings.
 */
import assert from "node:assert/strict";

/** a keyword in its other casings: each of its words (split at "-" and
 *  where a camelCase word starts) as written, lower, upper or capitalised */
export function otherCasings(keyword: string): string[] {
  let spellings = [""];
  for (const word of keyword.match(/[A-Z]?[a-z]+|[A-Z\d]+(?![a-z])|-/g) ?? []) {
    const forms = new Set([
      word,
      word.toLowerCase(),
      word.toUpperCase(),
      word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    ]);
    spellings = spellings.flatMap((start) => [...forms].map((form) => start + form));
  }
  assert.ok(spellings.includes(keyword), keyword);
  return spellings.filter((spelling) => spelling !== keyword);
}
