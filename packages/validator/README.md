# @miragon/design-iq-validator

Deterministic validator for designIQ content repositories: `designiq.yml` discovery, BPMN
structural checks (flow soundness, complete BPMNDI coverage), DMN structure and DMNDI coverage,
the generic cross-model reference rule (every required reference — `callActivity` calls,
`businessRuleTask` decides — must resolve in the repo), the schema check of the Miragon JSON
notations, and a per-mediaKind parse baseline for every other registered notation (a file that
is no JSON or XML is an ERROR; DSL notations are lenient by design; a `mermaid` fence in a
Markdown document that does not start with a diagram type such as `flowchart` or
`sequenceDiagram` is a WARN, `mermaid/diagram-type`, naming the document's line). Every finding
carries a stable `ruleId` (e.g. `bpmn/flow`, `dmn/di`, `refs/dangling`). It treats the target
repo as pure data — it never executes content-repo code. Exit code 0 = no errors (warnings
allowed), 1 = errors.

## Team Topologies, Context Maps and Value Chains

A `.tt`/`.ttm.json`, `.cm.json` or `.vc.json` file is parsed with the schema model its canvas
opens it with (`@miragon/team-topologies-schema-model`, `@miragon/context-maps-schema-model`,
`@miragon/value-chain-schema-model`). Whatever the schema model refuses, the canvas cannot open,
so each refusal is an ERROR (`team-topology/schema`, `context-map/schema`,
`value-chain/schema`) that names the offending value by its JSON path, e.g.
`nodes.1.id: duplicate id "a"`. Refused among others:

- a duplicate id, and the ids the diagram keeps for itself: `tt-root`, `cm-root`, `vc-root`,
  every id starting with `__implicitroot`, and `assoc_<annotation id>` in a Team Topology;
- in all three notations, an id that names a built-in JavaScript object property such as
  `constructor`, `toString` or `__proto__`: the canvas keeps its elements in a plain object and
  cannot import it;
- in a Team Topology whose `version` is not 1, a file without `version` included: an interaction
  without `position` or `size`, at the missing field (`interactions.0.size`). Opened anyway, it
  would drop out of the file with the next save. A version 1 file still loses its edge
  interactions, which have no geometry;
- in a Context Map: a JSON list instead of an object, a `version` newer than 1, coordinates or
  sizes beyond 1,000,000, and a repeated id at the path of the repeat, e.g.
  `contexts.2.id: duplicate id "a"; ids must be unique across contexts and relationships`;
- in a Value Chain: keys other than `x`, `y`, `width`, `height` in `bounds` and other than `x`,
  `y` in a waypoint, coordinates beyond ±1e9, a `__proto__` key anywhere, and nesting deeper than
  100 levels.

A Context Map's strategic-DDD rules (`validateDocument`, e.g. `protect-or-conform`,
`endpoints-on-map`) are WARNs, `context-map/semantics`, with the rule named at the end of the
message: the canvas opens such a map and marks the finding.

Paths count in the file, a Team Topology's interactions included. Some rules only run once the
document's shape is valid: the id rules of a Team Topology and a Value Chain, and a Context Map's
strategic-DDD rules. Fixing the reported errors can therefore bring up further ones, so check
again until the file is clean.

## Usage

```sh
# validate the content repo in the current directory
npx @miragon/design-iq-validator --root .

# validate a single process
npx @miragon/design-iq-validator --root . order-to-cash
```

`--root` points at any checkout that follows the content contract (a root `designiq.yml` naming
the models folder — `models:`, legacy alias `processes:`). A repo that still carries the legacy
file name `bpmiq.yml` validates unchanged, plus one `[WARN]` that suggests the rename
(`git mv bpmiq.yml designiq.yml`); the exit code is not affected.

## Part of designIQ

Source, content contract, and the example content repo live in
[Miragon/design-iq](https://github.com/Miragon/design-iq) — see
[docs/on-prem](https://github.com/Miragon/design-iq/tree/main/docs/on-prem) for running the
platform yourself.

## License

MIT
