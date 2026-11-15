/**
 * The board capability: what a `.board` file is beyond its codec. The board
 * is the structured notation (./index), JSON lines at rest (./codecs): one
 * header line, then one line per element sorted by id.
 *
 * parseBoardText reads that text STRICTLY. The codec's own decode is total: a
 * line it cannot read is skipped. That is right for a seed and wrong wherever
 * the text is edited and written back (a text host of the board, a hand
 * edit, a merge), because what the decode skipped the next export drops. So a
 * text holding anything the board would not write back is refused as a
 * whole. Consumers: the web client's contract module (a text host keeps the
 * document it shows, law L7 of @miragon/modeler-api) and the validator (a
 * broken board file is an ERROR before it reaches a canvas).
 *
 * Pure + browser-safe, like every capability module.
 */
import { jsonLinesCodec, type StructuredSnapshot } from "./codecs.ts";

const codec = jsonLinesCodec();
/** the header's format tag and the version this board reads (codecs.ts) */
const HEADER_FORMAT = "structured-model";
const HEADER_VERSION = 1;
const HEADER_KEYS: ReadonlySet<string> = new Set(["format", "version", "meta"]);

export type ParsedBoard = { ok: true; snapshot: StructuredSnapshot } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The snapshot of a board text, or why it is refused. Accepted: an empty text (a new board), and a
 * text with exactly one header and any number of element lines in any order, each a JSON object
 * with a non-empty string `id` that no other line has. Keys and element kinds the board does not
 * know are kept as they are: they stay in the document, off the canvas, and are written back.
 */
export function parseBoardText(text: string): ParsedBoard {
  const refuse = (line: number, why: string): ParsedBoard => ({ ok: false, reason: `line ${line} ${why}` });
  // null prototype: an element id like "constructor" is an own key, never an inherited member
  const elements = Object.create(null) as Record<string, Record<string, unknown>>;
  let meta: Record<string, unknown> | undefined;
  let rows = 0;
  let number = 0;
  for (const line of text.split("\n")) {
    number++;
    if (line.trim() === "") continue;
    rows++;
    // a Y.Map's toJSON assigns this key as a prototype and loses it: it would not be written back
    if (line.includes('"__proto__"')) return refuse(number, "has a key named __proto__");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return refuse(number, "is no JSON");
    }
    if (!isObject(parsed)) return refuse(number, "is no JSON object");
    if (typeof parsed.id === "string" && parsed.id.length > 0) {
      if (Object.hasOwn(elements, parsed.id)) return refuse(number, `repeats the element id ${parsed.id}`);
      const { id, ...attrs } = parsed;
      elements[id] = attrs;
      continue;
    }
    if (parsed.format !== HEADER_FORMAT) return refuse(number, "is neither the header nor an element with an id");
    if (meta !== undefined) return refuse(number, "is a second header");
    if (parsed.version !== HEADER_VERSION) {
      return refuse(
        number,
        `has the format version ${JSON.stringify(parsed.version)}, this board reads ${HEADER_VERSION}`,
      );
    }
    const unknown = Object.keys(parsed).filter((key) => !HEADER_KEYS.has(key));
    if (unknown.length > 0)
      return refuse(number, `has header keys the board would not write back: ${unknown.join(", ")}`);
    if (!isObject(parsed.meta)) return refuse(number, "has a header without a meta object");
    meta = parsed.meta;
  }
  // elements without a header: some other tool's JSON lines, not a board
  if (rows > 0 && meta === undefined) return { ok: false, reason: "the text has no header line: not a board file" };
  return { ok: true, snapshot: { elements: { ...elements }, meta: meta ?? {} } };
}

/** the canonical text of a snapshot: what the board exports */
export const encodeBoard = (snapshot: StructuredSnapshot): string => codec.encode(snapshot);
