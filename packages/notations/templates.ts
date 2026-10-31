/**
 * The template capability: blank-model file content per notation, keyed by
 * descriptor id. templateFor() is the generic dispatch the noun-driven create
 * path consumes (epic #118 step 5); the typed creates (live-host scaffold)
 * keep the named builders.
 *
 * Moved here from the live-host domain (epic #118 step 3) so creating a model
 * of ANY notation with a template becomes one registry lookup. Pure string
 * assembly, zero-dep and browser-safe like the package index.
 */

/** escape a string for use inside an XML attribute value */
export function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * XML ids are NCNames — they must not start with a digit, while a file stem
 * (the process id) may. Prefix such ids so "2nd-level-support.bpmn" still
 * yields a valid model; callActivity links resolve against the FILE STEM,
 * never the XML id, so the prefix is invisible to the platform.
 */
export function xmlProcessId(id: string): string {
  return /^[A-Za-z_]/.test(id) ? id : `p-${id}`;
}

/**
 * The initial content of a newly created process file: ONE unnamed none
 * start event in a plain process, with its BPMNDI, and nothing else (#183).
 * No pool, no end event, no flow: whether the model becomes a collaboration,
 * and what its pools and events are called, is the modeller's call, and a
 * placeholder name would end up in released models. The validator takes a
 * model holding only this start event as a fresh draft, not a dead end, so a
 * new model still opens with zero errors. The title is the process name,
 * which the derived view (./derive) falls back to when no pool names it.
 *
 * The start event's id is element-id-naming's default for an unnamed start
 * event, the one bpmn-cli gives it (edit_process's new ids follow the same
 * rule); its DI takes bpmn-js's `<id>_di`, which bpmn-cli keeps writing in a
 * file of that form. The shape sits where the old template's start event did,
 * inside the viewport the editor's first fit-viewport shows.
 */
export function newBpmnXml(id: string, name: string): string {
  const xmlId = xmlProcessId(id);
  const title = escapeXml(name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_${xmlId}" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${xmlId}" name="${title}" isExecutable="false">
    <bpmn:startEvent id="startEvent_start" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_${xmlId}">
    <bpmndi:BPMNPlane id="BPMNPlane_${xmlId}" bpmnElement="${xmlId}">
      <bpmndi:BPMNShape id="startEvent_start_di" bpmnElement="startEvent_start">
        <dc:Bounds x="232" y="162" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

/**
 * The initial content of a newly created decision file — the MINIMAL model
 * dmn-js opens with all views intact: one decision holding an empty decision
 * table (one input, one output, no rules) plus DMNDI for the DRD. Same
 * NCName rule as processes (xmlProcessId); links resolve against the FILE
 * STEM, never the XML id.
 */
export function newDmnXml(id: string, name: string): string {
  // the namespace base below is FROZEN (ADR 0008): every existing decision
  // carries it, and new ones keep it so old and new decisions stay alike
  const xmlId = xmlProcessId(id);
  const title = escapeXml(name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" xmlns:di="http://www.omg.org/spec/DMN/20180521/DI/" id="Definitions_${xmlId}" name="${title}" namespace="http://bpmiq.dev/dmn/${xmlId}">
  <decision id="${xmlId}" name="${title}">
    <decisionTable id="DecisionTable_${xmlId}" hitPolicy="UNIQUE">
      <input id="Input_1">
        <inputExpression id="InputExpression_1" typeRef="string">
          <text></text>
        </inputExpression>
      </input>
      <output id="Output_1" typeRef="string" />
    </decisionTable>
  </decision>
  <dmndi:DMNDI>
    <dmndi:DMNDiagram id="DMNDiagram_${xmlId}">
      <dmndi:DMNShape id="DMNShape_${xmlId}" dmnElementRef="${xmlId}">
        <dc:Bounds height="80" width="180" x="160" y="100" />
      </dmndi:DMNShape>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>
</definitions>
`;
}

/** one text line, whatever the input: control chars break line-oriented
 *  formats (OWM) and JSON strings get their own escaping. U+2028/U+2029 are
 *  LineTerminators for JS /m regexes — without them here, a pasted separator
 *  would smuggle a second logical line into the "title-only" template. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
}

/**
 * The initial content of a new Wardley map — the OWM DSL is line-oriented and
 * lenient; a lone title renders the empty evolution grid in the Miragon
 * modeler and round-trips untouched.
 */
export function newOwmText(_id: string, name: string): string {
  return `title ${oneLine(name)}\n`;
}

/**
 * The initial content of a new Team Topology — EXACTLY the schema-model's
 * canonical serialization (version 3, 2-space indent, an empty `annotations`
 * list left out, a trailing newline since 0.11.0): the modeler's first save
 * re-serializes canonically, and a byte-identical template keeps that save
 * from showing up as a phantom diff.
 */
export function newTtJson(_id: string, name: string): string {
  return `${JSON.stringify({ version: 3, title: oneLine(name), nodes: [], interactions: [], flows: [] }, null, 2)}\n`;
}

/**
 * The initial content of a new Event Storming board — EXACTLY what the
 * Miragon modeler's serializer emits for a board holding only a title, so
 * the first canvas save never shows up as a phantom diff. The .storm DSL is
 * line-oriented and lenient like OWM.
 */
export function newStormText(_id: string, name: string): string {
  return `title ${oneLine(name)}\n`;
}

/**
 * The initial content of a new Context Map — EXACTLY the schema-model's
 * canonical file text (version 1, 2-space indent, key order
 * version/title/contexts/relationships, a trailing newline): the modeler's
 * first save re-serializes canonically, and a byte-identical template keeps
 * that save from showing up as a phantom diff (the team-topology rule).
 */
export function newCmJson(_id: string, name: string): string {
  return `${JSON.stringify({ version: 1, title: oneLine(name), contexts: [], relationships: [] }, null, 2)}
`;
}

/**
 * The initial content of a new Value Chain: EXACTLY the schema-model's
 * canonical file text (schema version 1, every key sorted, 2-space indent, a
 * trailing newline): the modeler's first save re-serializes canonically, and
 * a byte-identical template keeps that save from showing up as a phantom
 * diff (the team-topology rule). The keys are written in sorted order here.
 */
export function newVcJson(_id: string, name: string): string {
  return `${JSON.stringify({ connections: [], elements: [], meta: { name: oneLine(name) }, schemaVersion: 1 }, null, 2)}\n`;
}

/** the initial content of a new markdown document — a heading with the title */
export function newMarkdownText(_id: string, name: string): string {
  return `# ${oneLine(name)}\n`;
}

const TEMPLATES: Record<string, (id: string, name: string) => string> = {
  bpmn: newBpmnXml,
  dmn: newDmnXml,
  wardley: newOwmText,
  "team-topology": newTtJson,
  "event-storming": newStormText,
  "context-map": newCmJson,
  "value-chain": newVcJson,
  markdown: newMarkdownText,
};

/** whether a notation can be CREATED from the platform (drives the web
 *  client's "New" menu and the generic create route) — false means its files
 *  arrive via git only */
export function hasTemplate(notation: string): boolean {
  // Object.hasOwn, NOT `in`: "toString"/"constructor" must never count as
  // template-capable (prototype chain — the bug class #126's review pinned)
  return Object.hasOwn(TEMPLATES, notation);
}

/**
 * THE generic template dispatch: the blank-file content for a notation, or
 * `undefined` when it has no template (such a notation cannot be created
 * from the platform — its files arrive via git).
 */
export function templateFor(notation: string, id: string, name: string): string | undefined {
  // hasOwn-gated: a bare TEMPLATES[notation] would resolve prototype members —
  // templateFor("toString", …) used to return "[object Object]" as a template
  return Object.hasOwn(TEMPLATES, notation) ? TEMPLATES[notation]?.(id, name) : undefined;
}
