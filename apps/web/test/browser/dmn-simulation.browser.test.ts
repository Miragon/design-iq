/**
 * The simulation add-on's Simulate DRD card as both hosts mount it (lib/dmn-simulation.ts), on a
 * DRD whose InputData carry the type dmn-js gives every new one, `Any`, which the card reads as a
 * string. A decision table has to read such a value as its own column's type, as the add-on's
 * decision-table form and @designiq/decisions do: "1" matches `1` in a number column, "true"
 * matches `true` in a boolean one. The add-on stopped doing that in 0.4.0 and the workspace
 * patches it back (patchedDependencies in pnpm-workspace.yaml), so this fails without the patch.
 */
import DmnModeler from "dmn-js/lib/Modeler";
import { afterEach, expect, test } from "vitest";

import { withDrdCanvasTheme } from "../../src/lib/canvas-theme.ts";
import { dmnSimulationViews } from "../../src/lib/dmn-simulation.ts";
import postage from "./fixtures/dmn/postage.dmn?raw";

const mounted: Array<{ container: HTMLElement; modeler: DmnModeler }> = [];

afterEach(() => {
  for (const { container, modeler } of mounted.splice(0)) {
    modeler.destroy();
    container.remove();
  }
});

async function mountCard(): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.style.cssText = "position: relative; width: 1000px; height: 700px";
  document.body.append(container);
  const modeler = new DmnModeler({ container, ...withDrdCanvasTheme(dmnSimulationViews) });
  mounted.push({ container, modeler });
  await modeler.importXML(postage);
  return container;
}

function card(container: HTMLElement): HTMLElement {
  const panel = container.querySelector<HTMLElement>(".dmn-sim-decision-requirements-diagram-panel");
  if (!panel) throw new Error("the Simulate DRD card is not mounted");
  return panel;
}

function enter(container: HTMLElement, label: string, value: string): void {
  const field = [...card(container).querySelectorAll(".dmn-sim-field")].find(
    (candidate) => candidate.querySelector(".dmn-sim-field-label")?.textContent === label,
  );
  const input = field?.querySelector<HTMLInputElement>("input.dmn-sim-input");
  if (!input) throw new Error(`no text field for ${label}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function simulate(container: HTMLElement): void {
  card(container).querySelector<HTMLButtonElement>(".dmn-sim-run")?.click();
}

/** the result badge the card puts on each decision that fired, by decision id */
function badges(container: HTMLElement): Record<string, string> {
  const byDecision: Record<string, string> = {};
  for (const overlays of container.querySelectorAll<HTMLElement>(".djs-overlays")) {
    const badge = overlays.querySelector(".dmn-sim-badge");
    if (badge && overlays.dataset.containerId) byDecision[overlays.dataset.containerId] = badge.textContent ?? "";
  }
  return byDecision;
}

test("the Simulate DRD card reads an InputData typed Any as the number or boolean column that reads it", async () => {
  const container = await mountCard();
  enter(container, "Country", "DE");
  enter(container, "Weight", "1");
  enter(container, "Express", "false");
  simulate(container);
  await expect.poll(() => badges(container)).toEqual({ zone: "domestic", postage: "4.9" });

  enter(container, "Express", "true");
  simulate(container);
  await expect.poll(() => badges(container)).toEqual({ zone: "domestic", postage: "19.9" });
});
