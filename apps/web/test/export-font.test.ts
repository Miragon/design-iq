/**
 * Geist inside a PNG export's SVG (src/lib/export-font.ts): which of the
 * page's @font-face rules go in (the family the renderers name first, the
 * subsets the diagram's text uses), how their files get inline (a data: src
 * as it is, a URL fetched once and resolved against its sheet), and where
 * the faces land in the SVG, each with the hidden text that makes it load
 * before the image counts as loaded: a character that face alone draws. jsdom keeps no src or unicode-range in a
 * parsed @font-face, so the rules here are the CSSOM's shape, written out.
 */
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { covers, embedGeist, type FontFaceSource, geistFontFaces } from "../src/lib/export-font.ts";
import { closeDom } from "./renderer-dom.ts";

after(closeDom);

/** fontsource 5.3.0's ranges, as Chromium serializes them */
const LATIN = "U+0-FF, U+131, U+152-153, U+2BB-2BC, U+2C6, U+2DA, U+2DC, U+304, U+308, U+329, U+2000-206F, U+20AC";
const LATIN_EXT = "U+100-2BA, U+2BD-2C5, U+2C7-2CC, U+1E00-1E9F, U+2C60-2C7F, U+A720-A7FF";
const CYRILLIC = "U+301, U+400-45F, U+490-491, U+4B0-4B1, U+2116";
const LATIN_DATA = "data:font/woff2;base64,bGF0aW4=";

function rule(declarations: Record<string, string>, href: string | null = null): FontFaceSource {
  return {
    style: { getPropertyValue: (name: string) => declarations[name] ?? "" },
    parentStyleSheet: { href },
  };
}

const SHEET = "http://localhost/assets/index-abc.css";
/** what the SPA's sheet holds: fontsource's rules, ui-kit's "Geist" alias, Geist Mono */
const SPA_RULES = [
  rule(
    {
      "font-family": '"Geist Variable"',
      "font-style": "normal",
      "font-weight": "100 900",
      "unicode-range": CYRILLIC,
      src: 'url("/assets/geist-cyrillic-wght-normal.woff2") format("woff2-variations")',
    },
    SHEET,
  ),
  rule(
    {
      "font-family": '"Geist Variable"',
      "font-weight": "100 900",
      "unicode-range": LATIN_EXT,
      src: 'url("geist-latin-ext-wght-normal.woff2") format("woff2-variations")',
    },
    SHEET,
  ),
  rule({
    "font-family": "'Geist Variable'",
    "font-style": "normal",
    "font-weight": "100 900",
    "unicode-range": LATIN,
    src: `url("${LATIN_DATA}") format("woff2-variations")`,
  }),
  rule({ "font-family": '"Geist"', "unicode-range": LATIN, src: 'url("/assets/alias.woff2")' }),
  rule({ "font-family": '"Geist Mono Variable"', "unicode-range": LATIN, src: 'url("/assets/mono.woff2")' }),
];

const fetched: string[] = [];
const realFetch = globalThis.fetch;
function serveFonts(status = 200): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = String(input);
    fetched.push(href);
    return new Response(status === 200 ? new TextEncoder().encode(`bytes of ${href}`) : null, {
      status,
      headers: { "content-type": "font/woff2" },
    });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
  fetched.length = 0;
});

const base64 = (text: string): string => Buffer.from(text).toString("base64");

/** the faces' rules as they go into the SVG's <style> */
const geistFontFaceCss = async (text: string, rules: Iterable<FontFaceSource>): Promise<string> =>
  (await geistFontFaces(text, rules)).map((face) => face.rule).join("");

test("covers: a unicode-range as the CSSOM serializes it, wildcards, and a face without one", () => {
  const codePoints = (text: string) => Array.from(text, (char) => char.codePointAt(0)!);
  assert.equal(covers(LATIN, codePoints("Tea Shop")), true);
  assert.equal(covers(LATIN, codePoints("Чай")), false);
  assert.equal(covers(CYRILLIC, codePoints("Чай")), true);
  assert.equal(covers(LATIN_EXT, codePoints("Łódź")), true, "Ł and ź are latin-ext");
  assert.equal(covers("u+0000-00ff", codePoints("a")), true, "any case, leading zeros");
  assert.equal(covers("U+4??", codePoints("Ж")), true, "a wildcard range");
  assert.equal(covers("U+4??", codePoints("a")), false);
  assert.equal(covers("", codePoints("字")), true, "no unicode-range: every character");
  assert.equal(covers("", []), false, "no text: no face");
});

test("geistFontFaces: only the 'Geist Variable' subsets the text uses, each src inline, the rule's descriptors kept", async () => {
  serveFonts();
  const latinOnly = await geistFontFaceCss("Cup of Tea → Hot Water", SPA_RULES);
  assert.equal(
    latinOnly,
    `@font-face{font-family:'Geist Variable';font-style:normal;font-weight:100 900;unicode-range:${LATIN};font-display:swap;src:url("${LATIN_DATA}");}`,
  );
  assert.deepEqual(fetched, [], "a data: src goes in as it is; the alias and Geist Mono stay out");

  const mixed = await geistFontFaceCss("Tee: Чай, Łódź", SPA_RULES);
  const cyrillic = "http://localhost/assets/geist-cyrillic-wght-normal.woff2";
  const latinExt = "http://localhost/assets/geist-latin-ext-wght-normal.woff2";
  assert.deepEqual(fetched, [cyrillic, latinExt], "a URL src resolves against its sheet");
  assert.equal(mixed.match(/@font-face/g)?.length, 3);
  assert.ok(mixed.includes(`src:url("data:font/woff2;base64,${base64(`bytes of ${cyrillic}`)}")`));
  assert.ok(mixed.includes(`unicode-range:${CYRILLIC};`));
  assert.ok(mixed.includes(`src:url("data:font/woff2;base64,${base64(`bytes of ${latinExt}`)}")`));

  await geistFontFaceCss("Чай", SPA_RULES);
  assert.equal(fetched.length, 2, "a file is fetched once per page");
});

test("geistFontFaces: each face's sample is a character it draws, not white space and not one a face declared after it draws", async () => {
  serveFonts();
  const samples = async (text: string, rules: Iterable<FontFaceSource>) =>
    (await geistFontFaces(text, rules)).map((face) => face.sample);
  assert.deepEqual(await samples("Tee: Чай, Łódź", SPA_RULES), ["Ч", "Ł", "T"], "cyrillic, latin-ext, latin");
  assert.deepEqual(
    await samples("Чай чай", SPA_RULES),
    ["Ч", undefined],
    "latin is in only for the space: no character to set",
  );
  // fontsource declares vietnamese before latin-ext, and both hold Ă: latin-ext draws it
  const vietnamese = rule({
    "font-family": "Geist Variable",
    "unicode-range": "U+102-103, U+1EA0-1EF9",
    src: `url("${LATIN_DATA}")`,
  });
  const latinExt = rule({ "font-family": "Geist Variable", "unicode-range": LATIN_EXT, src: `url("${LATIN_DATA}")` });
  assert.deepEqual(await samples("Ăn ạ", [vietnamese, latinExt]), ["ạ", "Ă"]);
});

test("geistFontFaces: no Geist on the page is an error; a failed fetch is one too, and the next export fetches again", async () => {
  await assert.rejects(geistFontFaceCss("Tea", SPA_RULES.slice(3)), /the page has no Geist Variable/);
  const vietnamese = rule(
    { "font-family": "Geist Variable", "unicode-range": "U+1EA0-1EF9", src: "url(/assets/geist-vietnamese.woff2)" },
    SHEET,
  );
  serveFonts(404);
  await assert.rejects(geistFontFaceCss("Tiếng Việt", [vietnamese]), /answered 404/);
  serveFonts();
  assert.match(await geistFontFaceCss("Tiếng Việt", [vietnamese]), /data:font\/woff2;base64,/);
  assert.deepEqual(fetched, [
    "http://localhost/assets/geist-vietnamese.woff2",
    "http://localhost/assets/geist-vietnamese.woff2",
  ]);
});

test("embedGeist: the faces go into a <style> ahead of the drawing, each loaded by a hidden text; an SVG without text stays as it is", async () => {
  serveFonts();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80"/>' +
    "<text font-family=\"'Geist Variable', 'Geist', ui-sans-serif\">Cup of Tea from Łódź</text></svg>";
  const embedded = new DOMParser().parseFromString(await embedGeist(svg, SPA_RULES), "image/svg+xml");
  const [defs, preload, drawing] = [...embedded.documentElement.children];
  assert.equal(defs?.localName, "defs");
  assert.equal(defs.firstElementChild?.localName, "style");
  const latinExt = `data:font/woff2;base64,${base64("bytes of http://localhost/assets/geist-latin-ext-wght-normal.woff2")}`;
  const faces = defs.textContent?.match(/@font-face\{[^}]*\}/g) ?? [];
  assert.equal(faces.length, 2, "latin-ext and latin, each once: no second copy of a file");
  assert.ok(faces[0]!.startsWith("@font-face{font-family:'Geist Variable';") && faces[0]!.includes(latinExt));
  assert.ok(faces[1]!.startsWith("@font-face{font-family:'Geist Variable';") && faces[1]!.includes(LATIN_DATA));
  assert.equal(preload?.localName, "g");
  assert.equal(preload.getAttribute("visibility"), "hidden");
  assert.deepEqual(
    [...preload.children].map((text) => [text.localName, text.getAttribute("font-family"), text.textContent]),
    [
      ["text", "'Geist Variable'", "Ł"],
      ["text", "'Geist Variable'", "C"],
    ],
    "a character of the diagram per face, in the faces' order",
  );
  assert.equal(drawing?.localName, "rect", "the drawing as it was, after them");
  assert.equal(embedded.querySelector("svg > text")?.textContent, "Cup of Tea from Łódź");

  const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  assert.equal(await embedGeist(blank, SPA_RULES), blank);
  await assert.rejects(embedGeist("<svg", SPA_RULES), /cannot be parsed/);
});
