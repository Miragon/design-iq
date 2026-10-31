/**
 * The DMN fixtures the decision tests share: one table WITHOUT a DRD (how
 * decision tables are actually written in the wild), a two-step DRD with
 * modelled InputData whose second decision reads the first one's result, and
 * modelled InputData without a type, read by a number and a boolean column.
 */
import { type DerivedDecision, deriveDecision } from "@designiq/notations/derive";
import { extractModelGraph } from "@designiq/notations/extract";

export function view(xml: string): DerivedDecision {
  const graph = extractModelGraph(".dmn", xml);
  if (!graph) throw new Error("fixture is not parseable");
  return deriveDecision(graph);
}

/** a single table, no InputData nodes — `kundentyp`/`bestellwert` are free */
export const RABATT = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_rabatt" name="Rabatt" namespace="http://bpmiq.dev/dmn/rabatt">
  <decision id="rabatt" name="Rabatt">
    <decisionTable id="DT_rabatt" hitPolicy="FIRST">
      <input id="Input_1" label="Kundentyp">
        <inputExpression id="IE_1" typeRef="string"><text>kundentyp</text></inputExpression>
      </input>
      <input id="Input_2" label="Bestellwert">
        <inputExpression id="IE_2" typeRef="number"><text>bestellwert</text></inputExpression>
      </input>
      <output id="Output_1" name="rabatt" typeRef="number" />
      <rule id="Rule_stamm_gross">
        <inputEntry id="e1"><text>"stamm"</text></inputEntry>
        <inputEntry id="e2"><text>&gt;= 500</text></inputEntry>
        <outputEntry id="e3"><text>10</text></outputEntry>
      </rule>
      <rule id="Rule_stamm">
        <inputEntry id="e4"><text>"stamm"</text></inputEntry>
        <inputEntry id="e5"><text>-</text></inputEntry>
        <outputEntry id="e6"><text>5</text></outputEntry>
      </rule>
      <rule id="Rule_neu">
        <inputEntry id="e7"><text>"neu"</text></inputEntry>
        <inputEntry id="e8"><text>-</text></inputEntry>
        <outputEntry id="e9"><text>0</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>`;

/** two chained decisions over modelled InputData */
export const VERSAND = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_versand" name="Versand" namespace="http://bpmiq.dev/dmn/versand">
  <inputData id="InputData_land" name="Land"><variable id="v1" name="land" typeRef="string" /></inputData>
  <inputData id="InputData_gewicht" name="Gewicht"><variable id="v2" name="gewicht" typeRef="number" /></inputData>
  <decision id="zone" name="Versandzone">
    <variable id="v3" name="zone" typeRef="string" />
    <informationRequirement id="ir1"><requiredInput href="#InputData_land" /></informationRequirement>
    <decisionTable id="DT_zone" hitPolicy="UNIQUE">
      <input id="Input_land"><inputExpression id="IE_land" typeRef="string"><text>land</text></inputExpression></input>
      <output id="Output_zone" name="zone" typeRef="string" />
      <rule id="Rule_inland"><inputEntry id="z1"><text>"DE"</text></inputEntry><outputEntry id="z2"><text>"inland"</text></outputEntry></rule>
      <rule id="Rule_eu"><inputEntry id="z3"><text>"AT","CH"</text></inputEntry><outputEntry id="z4"><text>"eu"</text></outputEntry></rule>
    </decisionTable>
  </decision>
  <decision id="porto" name="Porto">
    <variable id="v4" name="porto" typeRef="number" />
    <informationRequirement id="ir2"><requiredDecision href="#zone" /></informationRequirement>
    <informationRequirement id="ir3"><requiredInput href="#InputData_gewicht" /></informationRequirement>
    <decisionTable id="DT_porto" hitPolicy="FIRST">
      <input id="Input_zone"><inputExpression id="IE_zone" typeRef="string"><text>zone</text></inputExpression></input>
      <input id="Input_gewicht"><inputExpression id="IE_gewicht" typeRef="number"><text>gewicht</text></inputExpression></input>
      <output id="Output_porto" name="porto" typeRef="number" />
      <rule id="Rule_inland_leicht">
        <inputEntry id="p1"><text>"inland"</text></inputEntry>
        <inputEntry id="p2"><text>&lt; 2</text></inputEntry>
        <outputEntry id="p3"><text>4.90</text></outputEntry>
      </rule>
      <rule id="Rule_inland_schwer">
        <inputEntry id="p4"><text>"inland"</text></inputEntry>
        <inputEntry id="p5"><text>-</text></inputEntry>
        <outputEntry id="p6"><text>7.90</text></outputEntry>
      </rule>
      <rule id="Rule_eu">
        <inputEntry id="p7"><text>"eu"</text></inputEntry>
        <inputEntry id="p8"><text>-</text></inputEntry>
        <outputEntry id="p9"><text>14.90</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>`;

/** modelled InputData that declare no type (read as strings), in a number and
 *  a boolean column: each column has to read the value as its own typeRef */
export const FREIGABE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_freigabe" name="Freigabe" namespace="http://bpmiq.dev/dmn/freigabe">
  <inputData id="InputData_betrag" name="Betrag"><variable id="v1" name="betrag" /></inputData>
  <inputData id="InputData_express" name="Express"><variable id="v2" name="express" /></inputData>
  <decision id="freigabe" name="Freigabe">
    <variable id="v3" name="freigabe" typeRef="string" />
    <informationRequirement id="ir1"><requiredInput href="#InputData_betrag" /></informationRequirement>
    <informationRequirement id="ir2"><requiredInput href="#InputData_express" /></informationRequirement>
    <decisionTable id="DT_freigabe" hitPolicy="FIRST">
      <input id="Input_betrag" label="Betrag"><inputExpression id="IE_betrag" typeRef="number"><text>betrag</text></inputExpression></input>
      <input id="Input_express" label="Express"><inputExpression id="IE_express" typeRef="boolean"><text>express</text></inputExpression></input>
      <output id="Output_freigabe" name="freigabe" typeRef="string" />
      <rule id="Rule_express">
        <inputEntry id="f1"><text>-</text></inputEntry>
        <inputEntry id="f2"><text>true</text></inputEntry>
        <outputEntry id="f3"><text>"sofort"</text></outputEntry>
      </rule>
      <rule id="Rule_gross">
        <inputEntry id="f4"><text>&gt;= 500</text></inputEntry>
        <inputEntry id="f5"><text>-</text></inputEntry>
        <outputEntry id="f6"><text>"pruefen"</text></outputEntry>
      </rule>
      <rule id="Rule_klein">
        <inputEntry id="f7"><text>&lt; 500</text></inputEntry>
        <inputEntry id="f8"><text>-</text></inputEntry>
        <outputEntry id="f9"><text>"automatisch"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>`;
