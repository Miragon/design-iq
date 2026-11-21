# @miragon/design-iq-validator

Deterministic validator for designIQ content repositories: `designiq.yml` discovery, BPMN
structural checks (flow soundness, complete BPMNDI coverage), DMN structure and DMNDI coverage,
the generic cross-model reference rule (every required reference must resolve in the repo:
`callActivity` calls, `businessRuleTask` decides, the models a board shows), the schema check of
the Miragon JSON notations, the strict read of a board, and a per-mediaKind parse baseline for
every other registered notation (a file that is no JSON or XML is an ERROR; DSL notations are
lenient by design; a `mermaid` fence in a Markdown document that does not start with a diagram
type such as `flowchart` or `sequenceDiagram` is a WARN, `mermaid/diagram-type`, naming the
document's line; another casing passes only where mermaid draws it, so `Ishikawa` passes and
`Flowchart` warns). Every finding
carries a stable `ruleId` (e.g. `bpmn/flow`, `dmn/di`, `refs/dangling`). It treats the target
repo as pure data — it never executes content-repo code. Exit code 0 = no errors (warnings
allowed), 1 = errors.

A BPMN model whose only flow node is one none start event, with no sequence flow or message flow,
is a fresh draft: designIQ creates every new BPMN model that way, so its start event is not
reported as a dead end. With a second flow node anywhere in the model (in another pool too), a
trigger on the event or any flow, every rule applies.

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
- in all three notations, objects and arrays nested more than 100 levels deep, the document
  counting as the first, at the first level too deep;
- in a Team Topology whose `version` is not 1, a file without `version` included: an interaction
  without `position` or `size`, at the missing field (`interactions.0.size`). Opened anyway, it
  would drop out of the file with the next save. A version 1 file still loses its edge
  interactions, which have no geometry;
- in a Context Map: a JSON list instead of an object, a `version` newer than 1, coordinates or
  sizes beyond 1,000,000, and a repeated id at the path of the repeat, e.g.
  `contexts.2.id: duplicate id "a"; ids must be unique across contexts and relationships`;
- in a Value Chain: keys other than `x`, `y`, `width`, `height` in `bounds` and other than `x`,
  `y` in a waypoint, coordinates beyond ±1e9 and a `__proto__` key anywhere.

A Context Map's strategic-DDD rules (`validateDocument`, e.g. `protect-or-conform`,
`endpoints-on-map`) are WARNs, `context-map/semantics`, with the rule named at the end of the
message: the canvas opens such a map and marks the finding.

Paths count in the file, a Team Topology's interactions included. Some rules only run once the
document's shape is valid: the id rules of a Team Topology and a Value Chain, and a Context Map's
strategic-DDD rules. Fixing the reported errors can therefore bring up further ones, so check
again until the file is clean.

## Boards

A `.board` file is one JSON line per element after a header line, and it is read as strictly as
the board's canvas reads it back (`@miragon/board-schema-model`): a line or a key the board's reader
skips, and the next save would therefore drop, is an ERROR, `board/parse`, that names the line,
e.g. `line 3 repeats the element id n_a`. Refused: a line that is no JSON or no JSON object,
elements without a header line, a second header, a header of another format version or with keys
the board does not write back, an element without a string `id` or with an id another line already
has, and a key named `__proto__` at any depth (also as an element id). An empty file is a new
board. Attributes and element kinds the board does not know pass: the board keeps them.

The reader takes each line as JSON reads it, and the next save writes that back in the board's
canonical form, which normalizes the JSON itself. A key a line repeats keeps its last value, the
one every JSON reader sees, and a number is written as the double it reads as, so an integer
beyond 2^53 loses its last digits, a number out of range (`1e400`) is written as `null` and `-0`
as `0`. None of these is refused.

The models a board shows (its model nodes, by their repository path) are references like a
`callActivity`'s, resolved by notation and file stem. A model that is not in the repository is a
WARN, `refs/dangling`. So is a path outside the models folder, even when a model of its notation
and stem is in the folder: the message names the path as outside, since only the files in the
models folder are models. A path in the models folder that names where a model was before it moved
to another folder is a WARN, `refs/stale-path`, that says where it is now. A board shown on a board
is a WARN, `board/nested-board`: the canvas cannot show it.

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
