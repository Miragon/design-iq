/**
 * A repository's models per notation — the notation's icon and its count,
 * where GitHub shows languages (#213). Each count reads with its notation's
 * noun ("12 BPMN processes") for a screen reader and as a tooltip; a repository never opened
 * on the host reads "not loaded yet", an older host's row its process and
 * decision line (@designiq/notations/counts — the wording the VS Code picker
 * shares).
 */
import { notationCount, repoCountsLine } from "@designiq/notations/counts";

import { notationIcon } from "@/components/notation-icon";
import type { RepoInfo } from "@/lib/api";

export function ModelCounts({ repo }: { repo: RepoInfo }) {
  const counts = Object.entries(repo.modelCounts ?? {}).filter(([, n]) => n > 0);
  if (counts.length === 0) return <span>{repoCountsLine(repo).summary}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {counts.map(([notation, n]) => {
        const Icon = notationIcon(notation);
        const label = notationCount(notation, n);
        return (
          <span key={notation} title={label} className="inline-flex items-center gap-1">
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span aria-hidden="true" className="tabular-nums">
              {n}
            </span>
            <span className="sr-only">{label}</span>
          </span>
        );
      })}
    </span>
  );
}
