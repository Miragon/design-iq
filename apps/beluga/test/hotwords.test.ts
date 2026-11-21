/**
 * Cutting glossary entries into the model's pieces. The rules run on a small
 * made-up vocabulary; Parakeet's own needs its tokens.txt, which comes with the
 * model (set BELUGA_MODELS_DIR, or that part is skipped).
 *
 * fixtures/parakeet-v3-pieces.json holds entries as the model's original
 * tokenizer cuts them: tokenizer.json of nvidia/parakeet-tdt-0.6b-v3 (revision
 * 541d1f9), run by Hugging Face's `tokenizers`; null where it gives <unk>.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { modelSpec } from "../src/core/models.ts";
import { missingFiles } from "../src/engine/files.ts";
import { hotwords, PieceEncoder } from "../src/engine/hotwords.ts";

/** a tokens.txt: piece and id per line, the lower the id the earlier the merge */
const tokens = (pieces: string[]): string => pieces.map((p, i) => `${p} ${i}`).join("\n");

const small = new PieceEncoder(
  tokens([
    "<unk>",
    "<|nospeech|>",
    "▁ab",
    "bc",
    "ab",
    "▁a",
    "bb",
    "▁",
    "a",
    "b",
    "c",
    "/",
    ":",
    "x",
    "f",
    "i",
    "<x>",
    "<",
    ">",
  ]),
);

test("pairs merge in the order of their pieces' ids, the leftmost first on a tie", () => {
  // bc (3) before ab (4): ▁ a b c -> ▁ a bc -> ▁a bc, never ▁ab c
  assert.deepEqual(small.encode("abc"), ["▁a", "bc"]);
  // bb twice, overlapping: the left pair merges
  assert.deepEqual(small.encode("bbb"), ["▁", "bb", "b"]);
});

test("every word starts at a boundary, and spaces in between count once", () => {
  assert.deepEqual(small.encode("  a   bc "), ["▁a", "▁", "bc"]);
});

test("a character outside the vocabulary or a digit gives no pieces", () => {
  assert.equal(small.encode("abz"), null);
  assert.equal(small.encode("ab1"), null);
  assert.equal(small.encode("   "), null);
});

test("control tokens are no pieces: their text is cut like any other", () => {
  assert.equal(small.encode("<unk>"), null);
  assert.deepEqual(small.encode("<x>"), ["▁", "<", "x", ">"]);
});

test("the text is NFKC-normalized first, as the original tokenizer does", () => {
  // the ligature ﬁ is f and i
  assert.deepEqual(small.encode("ﬁ"), ["▁", "f", "i"]);
});

test("the glossary for sherpa-onnx: pieces by spaces, phrases by slashes", () => {
  assert.deepEqual(hotwords(["abc", "a bc"], small), { text: "▁a bc/▁a ▁ bc", left: [] });
});

test("an entry the model cannot write, or with a piece sherpa-onnx reads as markup, is left out", () => {
  const result = hotwords(["abz", "a/b", "a:b", "b", "ab1"], small);
  assert.equal(result.text, "▁ b");
  assert.deepEqual(result.left, ["abz", "a/b", "a:b", "ab1"]);
});

const modelsDir = process.env.BELUGA_MODELS_DIR;
const ready = modelsDir !== undefined && missingFiles(modelsDir, "parakeet-v3").length === 0;

test(
  "Parakeet's pieces are the ones its original tokenizer cuts",
  { skip: !ready && "BELUGA_MODELS_DIR not set" },
  () => {
    const encoder = new PieceEncoder(
      readFileSync(join(modelsDir as string, modelSpec("parakeet-v3").dir, "tokens.txt"), "utf8"),
    );
    const expected = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "parakeet-v3-pieces.json"), "utf8"),
    ) as Record<string, string | null>;
    for (const [entry, pieces] of Object.entries(expected)) {
      assert.equal(encoder.encode(entry)?.join(" ") ?? null, pieces, entry);
    }
  },
);
