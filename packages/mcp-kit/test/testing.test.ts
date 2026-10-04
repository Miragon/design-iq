import assert from "node:assert/strict";
import { test } from "node:test";

import { toolNamesIn } from "../testing.ts";

test("toolNamesIn: snake_case tokens, backticked or bare — sorted and deduped", () => {
  assert.deepEqual(
    toolNamesIn("Start with `list_repos`, then list_models; `list_repos` again, and open_team_topology_modeler."),
    ["list_models", "list_repos", "open_team_topology_modeler"],
  );
});

test("toolNamesIn: prose, camelCase, file names and env vars are not tool names", () => {
  assert.deepEqual(toolNamesIn("Pass the baseVersion; designiq.yml names the models folder (.ttm.json)."), []);
  assert.deepEqual(toolNamesIn("LIVE_MCP_READONLY turns writes off"), []);
});
