/**
 * The glossary as the recognizer hears it. Parakeet boosts a phrase while it
 * decodes, but only as the sequence of tokens it would write the phrase in, so
 * each entry is cut into the model's own pieces first.
 *
 * Parakeet's tokenizer is a SentencePiece BPE, and its tokens.txt lists the
 * pieces by rank: a word is cut into characters, then the adjacent pair whose
 * joined piece ranks highest is merged, again and again. That reproduces the
 * model's own tokenizer from tokens.txt alone (test/hotwords.test.ts checks it
 * against cuts made by the original tokenizer).
 */

/** the word boundary of SentencePiece: every word starts with it */
const BOUNDARY = "▁";

export class PieceEncoder {
  /** piece to rank: the lower, the earlier the merge */
  readonly #rank = new Map<string, number>();

  /** `tokens` is the text of a tokens.txt: one `piece id` per line */
  constructor(tokens: string) {
    for (const line of tokens.split("\n")) {
      const space = line.lastIndexOf(" ");
      if (space <= 0) continue;
      const piece = line.slice(0, space);
      const id = Number(line.slice(space + 1));
      // <unk>, <blk>, <|nospeech|>: control tokens no text is cut into
      if (!Number.isInteger(id) || (piece.length > 1 && piece.startsWith("<") && piece.endsWith(">"))) continue;
      this.#rank.set(piece, id);
    }
  }

  /**
   * the pieces of a phrase, or null when it holds a character the model cannot
   * write, or a digit: the original tokenizer cuts numbers by rules of its own,
   * which this one does not reproduce
   */
  encode(phrase: string): string[] | null {
    if (/\p{N}/u.test(phrase)) return null;
    const words = phrase.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
    const pieces: string[] = [];
    for (const word of words) {
      const symbols = Array.from(BOUNDARY + word);
      if (symbols.some((s) => !this.#rank.has(s))) return null;
      pieces.push(...this.#merge(symbols));
    }
    return pieces.length > 0 ? pieces : null;
  }

  #merge(symbols: string[]): string[] {
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i + 1 < symbols.length; i++) {
        const rank = this.#rank.get(symbols[i]! + symbols[i + 1]!);
        // the leftmost pair wins a tie, as in SentencePiece
        if (rank !== undefined && rank < bestRank) {
          best = i;
          bestRank = rank;
        }
      }
      if (best < 0) return symbols;
      symbols.splice(best, 2, symbols[best]! + symbols[best + 1]!);
    }
  }
}

export interface Hotwords {
  /** the phrases as sherpa-onnx takes them for one stream: pieces by spaces, phrases by `/` */
  text: string;
  /** entries the model cannot write, left out */
  left: string[];
}

/**
 * The glossary for sherpa-onnx. It reads `/` as the end of a phrase and a piece
 * that begins with `:` as a score, so an entry that would hold such a piece is
 * left out with the ones the model cannot write.
 */
export function hotwords(entries: readonly string[], encoder: PieceEncoder): Hotwords {
  const phrases: string[] = [];
  const left: string[] = [];
  for (const entry of entries) {
    const pieces = encoder.encode(entry);
    if (!pieces || pieces.some((p) => p.includes("/") || /^[:#@]/u.test(p))) left.push(entry);
    else phrases.push(pieces.join(" "));
  }
  return { text: phrases.join("/"), left };
}
