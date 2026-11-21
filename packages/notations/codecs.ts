/**
 * The doc-codec capability (epic #118 step 8): how a STRUCTURED notation's
 * live document serializes to its canonical at-rest text — the bridge that
 * keeps git diffs, PR review, sha256 compare-and-set, per-file history and
 * the validator working on plain text while the LIVE document merges
 * element-wise (Y.Map, @designiq/contracts/live ELEMENTS_KEY/META_KEY).
 *
 * The board (`.board`) is the structured notation, and its codec is the
 * one of its canvas: @miragon/board-schema-model writes, reads and checks a
 * board for designIQ exactly as the board renderer does. The house codec
 * below (jsonLinesCodec) is the same format; the tests hold the two to the
 * same bytes. The pipeline (seed, write-through, stale-seed, CAS, reconcile)
 * is also exercised in CI through injected test codecs.
 *
 * Pure + browser-safe like every capability module (no fs, no XML).
 */
import { decodeBoard, encodeBoard, parseBoardText } from "@miragon/board-schema-model";

/** the plain-object snapshot of a structured live document */
export interface StructuredSnapshot {
  /** element id → attributes (id is NOT repeated inside the attributes) */
  elements: Record<string, Record<string, unknown>>;
  /** document-level values (title, level, lanes, …) */
  meta: Record<string, unknown>;
}

export interface DocCodec {
  /**
   * DETERMINISTIC canonical text: same snapshot → same bytes, regardless of
   * insertion order. Everything downstream depends on it — git diff, the
   * sha256 baseVersion, history, the validator's input.
   */
  encode(snapshot: StructuredSnapshot): string;
  /** TOTAL: any bytes → a snapshot (garbage → empty board, unparseable lines
   *  skipped) — a decode must never fail a seed or a listing */
  decode(text: string): StructuredSnapshot;
  /** the strict reader: undefined when `decode` keeps everything the text
   *  holds as its format reads it (a board: each line as JSON.parse reads
   *  it), else why not ("line 3 repeats the element id n_a"). Whoever writes
   *  a text into a live document or a file asks this first, since what
   *  `decode` skips the next `encode` drops. It does not refuse what the
   *  canonical `encode` normalizes in the JSON itself: a key a line repeats
   *  keeps its last value (the one JSON.parse reads), and a number becomes a
   *  double (an integer beyond 2^53 loses its last digits, one out of range
   *  such as 1e400 is written as null, -0 as 0). Absent = the
   *  codec cannot tell (a test codec) */
  check?(text: string): string | undefined;
}

/** recursively sort object keys so JSON.stringify is deterministic */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** the header's format tag — brand-NEUTRAL on purpose: it is persisted in
 *  every structured model file, and a product rename must never again have
 *  to touch (or dual-read) files in customer repos */
const HEADER_FORMAT = "structured-model";

/**
 * THE house codec: one JSON header line (format, version, meta), then one
 * JSON line per element sorted by id, trailing newline — a git diff of an
 * element edit touches exactly that element's line. The board's codec
 * (@miragon/board-schema-model) writes the same bytes for the same snapshot;
 * the tests compare the two.
 */
export function jsonLinesCodec(): DocCodec {
  return {
    encode(snapshot) {
      const lines = [JSON.stringify(canonicalize({ format: HEADER_FORMAT, version: 1, meta: snapshot.meta }))];
      for (const id of Object.keys(snapshot.elements).sort()) {
        // the map KEY is the authoritative id — an attr literally named "id"
        // must never re-key the element in the canonical text
        lines.push(JSON.stringify(canonicalize({ ...snapshot.elements[id], id })));
      }
      return `${lines.join("\n")}\n`;
    },
    decode(text) {
      // null-prototype container: an "__proto__" element id must become an
      // OWN key, never a prototype assignment
      const snapshot: StructuredSnapshot = {
        elements: Object.create(null) as StructuredSnapshot["elements"],
        meta: {},
      };
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // total decode: unparseable lines are skipped, never fatal
        }
        if (parsed === null || typeof parsed !== "object") continue;
        const row = parsed as Record<string, unknown>;
        // a header NEVER carries an id — an element whose attrs happen to
        // contain format:"structured-model" must not be swallowed as one
        if (row.format === HEADER_FORMAT && typeof row.id !== "string") {
          if (row.meta !== null && typeof row.meta === "object") snapshot.meta = row.meta as Record<string, unknown>;
          continue;
        }
        if (typeof row.id === "string" && row.id.length > 0) {
          const { id, ...attrs } = row;
          snapshot.elements[id as string] = attrs;
        }
      }
      // spread-copy back to a normal prototype: spread CreateDataProperty's
      // every own key (incl. a literal "__proto__"), never invoking setters —
      // callers get an ordinary object, deep-equality behaves as expected
      return { elements: { ...snapshot.elements }, meta: snapshot.meta };
    },
  };
}

/** the board's codec: its canvas's own format, reader and strict reader */
const boardCodec: DocCodec = {
  encode: encodeBoard,
  decode: decodeBoard,
  check(text) {
    const parsed = parseBoardText(text);
    return parsed.ok ? undefined : parsed.reason;
  },
};

/** notation id → its doc codec; registering here is the whole integration.
 *  Every notation whose descriptor is docShape "structured" has one (the
 *  tests hold the two together), or the Live Host would open it as text */
const DOC_CODECS: Record<string, DocCodec> = {
  board: boardCodec,
};

export function docCodecFor(notation: string): DocCodec | undefined {
  // Object.hasOwn: "toString" or "constructor" name no codec (the prototype
  // bug class templateFor was fixed for)
  return Object.hasOwn(DOC_CODECS, notation) ? DOC_CODECS[notation] : undefined;
}

// ── fractional-index ordering ────────────────────────────────────────────────

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A key strictly between `a` and `b` (base-36 fractional index, lexicographic
 * order) — timeline/board ordering without the Y.Array concurrent-insert
 * worst case: concurrent inserts at one gap yield distinct keys that still
 * sort deterministically. Omit `a` for "before b", `b` for "after a".
 */
export function fractionalIndexBetween(a?: string, b?: string): string {
  const lo = a ?? "";
  const hi = b ?? "";
  if (hi !== "" && lo >= hi) throw new Error(`fractional index bounds out of order: '${lo}' >= '${hi}'`);
  let result = "";
  for (let i = 0; ; i++) {
    // reaching the end of a non-empty upper bound with an equal prefix means
    // the interval is empty (a bound ending in the minimum digit — keys THIS
    // generator produces never do, so only malformed external input hits it)
    if (hi !== "" && i >= hi.length) throw new Error(`no key exists between '${lo}' and '${hi}'`);
    const dLo = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    const dHi = i < hi.length ? DIGITS.indexOf(hi[i]!) : DIGITS.length;
    if (dHi - dLo > 1) {
      // room for a midpoint digit at this position
      return result + DIGITS[Math.floor((dLo + dHi) / 2)]!;
    }
    // adjacent (or equal) digits: keep the low digit, descend one position
    result += DIGITS[dLo]!;
    if (dHi - dLo === 1) {
      // between x… and (x+1): everything below the upper bound is open — walk
      // the LOW side's remainder until a digit leaves headroom to append
      for (let j = i + 1; ; j++) {
        const d = j < lo.length ? DIGITS.indexOf(lo[j]!) : 0;
        if (d < DIGITS.length - 1) {
          const rest = lo.slice(i + 1, j);
          return result + rest + DIGITS[Math.floor((d + DIGITS.length) / 2)]!;
        }
        // digit is the maximum ('z') — carry it and keep walking
      }
    }
  }
}
