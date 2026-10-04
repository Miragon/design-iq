/**
 * The repo card's count line on the overview: "4 models", with the
 * per-notation breakdown ("2 BPMN processes · 1 DMN decision · 1 Event
 * Storming board") for the hover title. A host that predates modelCount
 * (5.0 and older) only sends the process and decision counts — the line falls
 * back to those; a repo not opened on the host yet has no counts at all.
 */
import type { RepoInfo } from "@designiq/contracts/live-host";
import { byId, type NotationDescriptor, NOTATIONS } from "@designiq/notations";

/** the registry label without a version ("BPMN 2.0" → "BPMN") */
const qualifier = (n: NotationDescriptor): string =>
  n.label
    .split(" ")
    .filter((w) => !/^[\d.]+$/.test(w))
    .join(" ");

/**
 * "2 BPMN processes", "1 Event Storming board", "3 Markdown documents" — the
 * registry noun of the notation, counted. A noun that already names its
 * notation ("event storming board") takes the label's spelling for those
 * words; any other noun gets the label in front ("processes" → "BPMN
 * processes"). An id this build does not know (a newer host) still counts.
 */
export function notationCount(notation: string, count: number): string {
  const n = byId(notation);
  if (!n) return `${count} ${notation} ${count === 1 ? "model" : "models"}`;
  const noun = count === 1 ? n.noun.singular : n.noun.plural;
  const words = noun.split(" ");
  const labelWords = qualifier(n).split(" ");
  if (words.length > 1 && words[0]?.toLowerCase() === labelWords[0]?.toLowerCase()) {
    const head = words
      .slice(0, -1)
      .map((w, i) => (labelWords[i]?.toLowerCase() === w.toLowerCase() ? labelWords[i] : w));
    return `${count} ${[...head, words.at(-1)].join(" ")}`;
  }
  return `${count} ${qualifier(n)} ${noun}`;
}

/** the per-notation breakdown in registry order; ids this build does not know come last */
export function modelBreakdown(counts: Record<string, number>): string {
  const known = new Set(NOTATIONS.map((n) => n.id));
  const ids = [...NOTATIONS.map((n) => n.id), ...Object.keys(counts).filter((id) => !known.has(id))];
  return ids
    .map((id) => [id, counts[id]] as const)
    .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([id, count]) => notationCount(id, count))
    .join(" · ");
}

export interface RepoCountsLine {
  /** what the card shows after the branch */
  summary: string;
  /** the per-notation breakdown for the hover title — absent when there is none */
  breakdown?: string;
}

const plural = (count: number, singular: string, pluralForm: string): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

export function repoCountsLine(
  r: Pick<RepoInfo, "processCount" | "decisionCount" | "modelCount" | "modelCounts">,
): RepoCountsLine {
  // != null: null is "not opened on this host yet", undefined an older host
  if (r.modelCount != null) {
    const breakdown = r.modelCounts ? modelBreakdown(r.modelCounts) : "";
    return { summary: plural(r.modelCount, "model", "models"), ...(breakdown ? { breakdown } : {}) };
  }
  if (r.processCount == null) return { summary: "not loaded yet" };
  // an older host: the process/decision line it always had
  const decisions =
    r.decisionCount != null && r.decisionCount > 0 ? ` · ${plural(r.decisionCount, "decision", "decisions")}` : "";
  return { summary: `${plural(r.processCount, "process", "processes")}${decisions}` };
}
