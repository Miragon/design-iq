/**
 * The widget icons (src/mcp-app/icons.ts) are copied Lucide geometry — this
 * holds every copy to the icon of the SAME name in the lucide-react the SPA
 * draws with, so the widgets and the SPA can never show two different "x".
 * A lucide-react bump that redraws an icon fails here: re-copy the node.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { LUCIDE_ICONS } from "../src/mcp-app/icons.ts";

type IconNode = Array<[string, Record<string, string>]>;

/** lucide-react's icon node as the SVG children markup icons.ts carries */
async function lucideMarkup(name: string): Promise<string> {
  const mod = (await import(`lucide-react/dist/esm/icons/${name}.mjs`)) as { __iconData: { node: IconNode } };
  return mod.__iconData.node
    .map(([tag, { key: _key, ...attrs }]) => {
      const list = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`);
      return `<${tag} ${list.join(" ")}/>`;
    })
    .join("");
}

test("every widget icon is the lucide-react icon of the same name", async () => {
  for (const [name, markup] of Object.entries(LUCIDE_ICONS)) {
    assert.equal(markup, await lucideMarkup(name), `icons.ts "${name}" drifted from lucide-react`);
  }
});
