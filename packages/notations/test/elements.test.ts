/**
 * modelElements / closestElements (#275): the ids a todo may anchor to, per
 * notation, and the ones closest to an id a model does not have. A todo
 * anchored to an id its canvas does not address shows no badge, so each
 * notation lists exactly what its canvas selects and reveals.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { closestElements, type ModelElement, modelElements } from "../elements.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const ids = (elements: ModelElement[] | undefined): string[] => (elements ?? []).map((element) => element.id);

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" id="Definitions_1">
  <bpmn:collaboration id="Collaboration_1"><bpmn:participant id="Pool_1" name="Sales" processRef="Process_1"/></bpmn:collaboration>
  <bpmn:process id="Process_1">
    <bpmn:laneSet id="LaneSet_1"><bpmn:lane id="Lane_1" name="Clerk"><bpmn:flowNodeRef>Task_1</bpmn:flowNodeRef></bpmn:lane></bpmn:laneSet>
    <bpmn:task id="Task_1" name="Check"/>
    <bpmn:task id="Task_1" name="Check again"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">
    <bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1"/>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

test("modelElements(bpmn): every semantic element, the diagram interchange is none, the first of a duplicated id wins", () => {
  assert.deepEqual(modelElements("order.bpmn", BPMN), [
    { id: "Definitions_1" },
    { id: "Collaboration_1" },
    { id: "Pool_1", name: "Sales" },
    { id: "Process_1" },
    { id: "LaneSet_1" },
    { id: "Lane_1", name: "Clerk" },
    { id: "Task_1", name: "Check" },
  ]);
});

test("modelElements: a text that does not parse throws, a document has no element ids", () => {
  assert.throws(() => modelElements("order.bpmn", "<bpmn:definitions"), /not well-formed XML/);
  assert.throws(() => modelElements("map.tt", "{"));
  assert.equal(modelElements("notes.md", "# Notes\n"), undefined);
  assert.equal(modelElements("notes.unknown", "x"), undefined);
});

test("modelElements(wardley): the elements the canvas addresses, under their cmp_* ids; a link is none", () => {
  const elements = modelElements("tea.owm", fixture("tea.owm"));
  assert.ok(ids(elements).includes("cmp_cup_of_tea"));
  assert.deepEqual(
    elements?.find((element) => element.id === "cmp_cup_of_tea"),
    { id: "cmp_cup_of_tea", name: "Cup of Tea" },
  );
  assert.deepEqual(
    ids(elements).filter((id) => /^(dep|flow)_/.test(id)),
    [],
    "dep_N and flow_N are numbered by line order",
  );
  assert.equal(modelElements("map.owm", "component Platform [0.3, 0.4]\nA -> B\nA +> B\n")?.length, 1);
});

test("modelElements(event-storming): the stickies; a note, a drawing and an arrow take their id from the line order", () => {
  const board = ["actor Customer [80, 300]", "event Order Placed [620, 300]", "note Remember [80, 80]"].join("\n");
  assert.deepEqual(modelElements("board.storm", `${board}\nline [[0, 0], [9, 9]]\nCustomer -> Order Placed\n`), [
    { id: "actor_customer", name: "Customer" },
    { id: "event_order_placed", name: "Order Placed" },
  ]);
  assert.ok(ids(modelElements("order-checkout.storm", fixture("order-checkout.storm"))).includes("agg_order_2"));
});

test("modelElements(context-map): contexts and relationships, both are selected on the canvas", () => {
  const elements = modelElements("conference.cm.json", fixture("conference.cm.json"));
  assert.ok(ids(elements).includes("ctx_auth"));
  assert.ok(
    ids(elements).some((id) => !id.startsWith("ctx_")),
    "the relationships follow the contexts",
  );
});

test("modelElements(team-topology): teams, interactions, flows and annotations", () => {
  const elements = modelElements("sample.tt", fixture("sample.tt"));
  assert.deepEqual(elements?.[0], { id: "team_checkout", name: "Checkout & Payments" });
  assert.equal(new Set(ids(elements)).size, elements?.length, "an id is listed once");
});

test("modelElements(team-topology): an id or a label that is no string names nothing", () => {
  const elements = modelElements(
    "draft.tt",
    '{"version":3,"nodes":[{"id":"team_a","label":42},{"id":7,"label":"B"},{"id":"","label":"C"}]}',
  );
  assert.deepEqual(elements, [{ id: "team_a" }]);
});

test("closestElements: a name counts as much as an id, so a component asked for by its name ranks its id first", () => {
  const elements: ModelElement[] = [
    { id: "cmp_checkout", name: "Checkout" },
    { id: "cmp_platform", name: "Platform" },
    { id: "anchor_business", name: "Business" },
  ];
  assert.deepEqual(closestElements(elements, "Platform"), [
    { id: "cmp_platform", name: "Platform" },
    { id: "cmp_checkout", name: "Checkout" },
    { id: "anchor_business", name: "Business" },
  ]);
  assert.deepEqual(closestElements(elements, "cmp_platfrom", 1), [{ id: "cmp_platform", name: "Platform" }]);
});

test("closestElements: case is ignored, a tie keeps the model order, the limit and an empty model hold", () => {
  const elements: ModelElement[] = [{ id: "b" }, { id: "a" }, { id: "c" }];
  assert.deepEqual(closestElements(elements, "x"), [{ id: "b" }, { id: "a" }, { id: "c" }]);
  assert.deepEqual(closestElements(elements, "x", 2), [{ id: "b" }, { id: "a" }]);
  assert.deepEqual(closestElements([{ id: "Task_Send_Offer" }, { id: "task_x" }], "TASK_SEND_OFFER", 1), [
    { id: "Task_Send_Offer" },
  ]);
  assert.deepEqual(closestElements([], "anything"), []);
});

test("closestElements: a very long id is compared by its start", () => {
  const long = `cmp_${"a".repeat(5000)}`;
  assert.deepEqual(closestElements([{ id: "cmp_b" }, { id: long }], `${long}b`, 1), [{ id: long }]);
});

test("closestElements: the pruned ranking equals ranking every element by its full edit distance", () => {
  const reference = (left: string, right: string): number => {
    const a = left.slice(0, 64).toLowerCase();
    const b = right.slice(0, 64).toLowerCase();
    const table = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        table[i]![j] = Math.min(
          table[i - 1]![j]! + 1,
          table[i]![j - 1]! + 1,
          table[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return table[a.length]![b.length]!;
  };
  let seed = 7;
  const next = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % bound;
  };
  const word = (): string => Array.from({ length: 1 + next(14) }, () => "abcDE_1-".charAt(next(8))).join("");
  for (let round = 0; round < 200; round++) {
    const elements: ModelElement[] = Array.from({ length: 1 + next(40) }, () =>
      next(3) === 0 ? { id: word(), name: word() } : { id: word() },
    );
    const wanted = word();
    const limit = 1 + next(5);
    const expected = elements
      .map((element, order) => ({
        element,
        order,
        distance: Math.min(
          reference(wanted, element.id),
          element.name === undefined ? Infinity : reference(wanted, element.name),
        ),
      }))
      .sort((x, y) => x.distance - y.distance || x.order - y.order)
      .slice(0, limit)
      .map(({ element }) => element);
    assert.deepEqual(closestElements(elements, wanted, limit), expected, `round ${round}: ${wanted}`);
  }
});
