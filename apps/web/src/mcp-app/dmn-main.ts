/**
 * The decision widget — the dmn engine on the shared widget core
 * (core/widget.ts + core/lifecycle.ts: App handshake → tool input → load the
 * live document → engine → CAS autosave with the conflict decision → the
 * newest-widget claim). What is DMN here: the simulation add-on inside the
 * engine (engines/dmn.ts), the DRD | Table switch (the core binds it to any
 * engine with views), the Checks card (dmn-checks.ts: findings, a scenario,
 * the test cases), the inlined dmn icon font and Geist Mono — and NO live
 * upgrade: the engine has no bindLive, so the core stays on CAS autosave (a
 * decision table is edited cell by cell by one person at a time; the
 * conflict flow covers the rare collision honestly).
 *
 * `open_decision_modeler` may carry a `scenario`, which rides along in the
 * tool input and is played straight into the simulator once the decision
 * table is up — so an agent can say "here is the case that fails" and the
 * user SEES the row that lights up.
 */
import "./dmn-styles.css";

import type { WidgetChrome } from "./chrome/contracts";
import { outputText } from "./core/checks-view";
import type { WidgetExtras } from "./core/lifecycle";
import { bootWidget } from "./core/widget";
import { mountChecks } from "./dmn-checks";
import { type DmnEngine, mountDmnEngine, type Scenario } from "./engines/dmn";
import { WIDGET_FONT_MONO } from "./font";

bootWidget<DmnEngine>({
  notation: "dmn",
  noun: "decision",
  engine: mountDmnEngine,
  // the FEEL cells are set in Geist Mono (geist-mono.css)
  fonts: ["dmn", WIDGET_FONT_MONO],
  extras: ({ app, engine, readonly, chrome }) => {
    const checks = mountChecks({ app, engine, readonly, chrome });
    let generation = 0; // bumps per document — a stale scenario replay bails out
    const extras: WidgetExtras = {
      // discovery in parallel with the import: the toggle carries its verdict from boot
      onRead: (doc) => checks.read(doc),
      onDocument: (_doc, input) => {
        const mine = ++generation;
        void (async () => {
          // dmn-js opens the DRD whenever the model has DMNDI, but a one-decision
          // file IS its table — and the simulator only exists in the table view.
          // Open it, or the widget's whole point sits one click away behind a box.
          await engine.openDecisionTable().catch(() => false);
          const scenario = (input as { scenario?: Scenario }).scenario;
          if (scenario && mine === generation) {
            await playScenario(engine, scenario, () => mine === generation, chrome);
          }
        })();
      },
      // findings and the suite re-check the stored decision (at most every 5 s)
      onSaved: (doc) => checks.saved(doc),
      destroy: () => {
        generation++;
        checks.destroy();
      },
    };
    return extras;
  },
});

/** an agent-supplied scenario: play it into the simulator. The table
 *  simulator only exists once its view is active, so retry briefly rather
 *  than dropping the scenario on the floor. The Checks card's "Try a
 *  scenario" shows it too — it reads the same store. */
async function playScenario(
  engine: DmnEngine,
  scenario: Scenario,
  alive: () => boolean,
  chrome: WidgetChrome,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!alive()) return;
    if (engine.applyScenario(scenario)) {
      const result = engine.scenario().result();
      requestAnimationFrame(() => engine.revealMatch());
      // the rules the hit policy reports — what the decision answers with
      const rules = result?.reported.map((i) => i + 1) ?? [];
      const answer = result && rules.length > 0 ? outputText(result) : undefined;
      const outcome =
        rules.length === 0
          ? "no rule matches"
          : rules.length === 1
            ? `rule ${rules[0]} matches`
            : `rules ${rules.join(", ")} match`;
      chrome.toast({
        tone: "info",
        title: `Scenario from the assistant — ${outcome}`,
        // the title names the rule; the detail what the decision answers with it
        ...(answer !== undefined ? { detail: `The decision answers ${answer}.` } : {}),
        key: "checks",
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (alive()) chrome.toast({ tone: "info", title: "Open the decision table view to see the scenario", key: "checks" });
}
