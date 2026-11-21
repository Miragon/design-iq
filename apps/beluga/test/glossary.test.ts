import assert from "node:assert/strict";
import { test } from "node:test";

import { checkGlossary, glossaryFromFile, MAX_ENTRIES, MAX_LENGTH, parseGlossary } from "../src/core/glossary.ts";

test("one entry per line, tidied, without empty lines and repeats", () => {
  assert.deepEqual(parseGlossary("Camunda\r\n\n  Anna   Wiśniewski \nCamunda\n\t\nDMN"), [
    "Camunda",
    "Anna Wiśniewski",
    "DMN",
  ]);
});

test("a line too long for a name or a term is no entry, and the list ends at the limit", () => {
  assert.deepEqual(parseGlossary(`${"x".repeat(MAX_LENGTH + 1)}\nERP`), ["ERP"]);
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => `term ${i}`).join("\n");
  assert.equal(parseGlossary(many).length, MAX_ENTRIES);
});

test("a start request's glossary is a list of strings or nothing", () => {
  assert.deepEqual(checkGlossary(undefined), []);
  assert.deepEqual(checkGlossary([" Camunda ", "Camunda", ""]), ["Camunda"]);
  assert.throws(() => checkGlossary("Camunda"), /not a list/);
  assert.throws(() => checkGlossary(["Camunda", 3]), /not a list/);
});

const brief = `# Workshop: Order to cash

## Participants

| Role | Speaks for | Decides |
| ---- | ---------- | ------- |
| Head of sales | Sales | yes |

## Glossary

Terms, names and abbreviations the group uses.

| Term | Means | Often misheard as |
| ---- | ----- | ----------------- |
| Rabattstaffel | discount tiers by order value | Rabatt Stapel |
| **DMN** | the decision tables | DM in |
| \`Camunda\` | the process engine | Kamunda |
| [Skontofrist](../terms.md) | days for the early-payment discount | Kontofrist |
| <...> | <...> | <...> |

### A note under the glossary

| Domain Event | something that happened | |

## Sessions

| Not a term | - | - |
`;

test("a brief gives the first column of its glossary table, without placeholders and markup", () => {
  assert.deepEqual(glossaryFromFile(brief), ["Rabattstaffel", "DMN", "Camunda", "Skontofrist", "Domain Event"]);
});

test("a brief whose glossary is still the template gives nothing", () => {
  assert.deepEqual(
    glossaryFromFile(
      "## Glossary\n\n| Term | Means | Often misheard as |\n| --- | --- | --- |\n| <...> | <...> | <...> |\n",
    ),
    [],
  );
});

test("a file without a glossary heading is a list, one entry per line", () => {
  assert.deepEqual(glossaryFromFile("Camunda\nAnna Wiśniewski\n"), ["Camunda", "Anna Wiśniewski"]);
});
