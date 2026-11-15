/**
 * The layers of the outer-scale module: each repairs one kind of site and can be switched on
 * alone, so an effect can be attributed. `&plugin=<comma list>` on the board's URL picks them.
 */
export const LAYERS = [
  "drag",
  "dragsvc",
  "pan",
  "wheel",
  "pad",
  "popup",
  "tip",
  "bend",
  "edit",
  "table",
  "own",
] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * What "one module for every engine" means, and what a URL without `plugin` gets. Not in it:
 * `dragsvc`, which repairs the same site as `drag` by another mechanism (one of the two), and
 * `own`, which reaches into three services of the Miragon renderers by their private names
 * (`&plugin=all,own`): an experiment on how far renderer-specific patches would carry.
 */
export const DEFAULT_LAYERS: readonly Layer[] = LAYERS.filter((layer) => layer !== "dragsvc" && layer !== "own");

/**
 * The layers a URL asks for: no `plugin` parameter or `plugin=all` gives the default set,
 * `plugin=none` (or an empty value) none at all, which is the naive strategy under this id. A name
 * that is no layer is dropped; the surface writes what is left on the host (`data-plugin-layers`).
 */
export function readLayers(search: string): Layer[] {
  const value = new URLSearchParams(search).get("plugin");
  if (value === null) return [...DEFAULT_LAYERS];
  const names = value.split(",").map((name) => name.trim());
  const wanted = new Set<string>(names.includes("all") ? [...DEFAULT_LAYERS, ...names] : names);
  return LAYERS.filter((layer) => wanted.has(layer));
}
