/**
 * The GitHub-side todo vocabulary: labels and the issues-list row shape. This
 * is TRACKER vocabulary, not platform wire types — ports/issue-tracker.ts
 * deliberately assumes no numbers, labels or markdown (Jira has neither), so
 * this lives with the GitHub plumbing, not in @designiq/contracts. The body
 * MARKUP (anchor block, attribution line) stays adapter-owned per that port.
 *
 * Zero imports — the read-only MCP server can adopt this without pulling the
 * App/JWT half of the package into its published bundle.
 */

/** the label every platform-managed todo carries */
export const TODO_LABEL = "todo";

/** a model as the labels name it: its notation (registry id) and its id */
export interface LabeledModel {
  notation: string;
  id: string;
}

/** the per-model label that makes the tracker-side filter cheap:
 *  `<notation>:<id>` (`bpmn:order-to-cash`, `wardley:tea-shop`) — ids are
 *  unique per notation only */
export const modelLabel = (model: LabeledModel): string => `${model.notation}:${model.id}`;

/** the `labels=` filter for listing: every todo, or one model's */
export const todoLabelQuery = (model?: LabeledModel): string =>
  model ? `${TODO_LABEL},${modelLabel(model)}` : TODO_LABEL;

/** one row of GitHub's issues list.
 *  NB the list INCLUDES pull requests — every consumer must filter them out
 *  (they carry a `pull_request` key; see isPullRequestRow). */
export interface GitHubIssueRow {
  number: number;
  html_url: string;
  title: string;
  state: string;
  body: string | null;
  assignees?: Array<{ login: string }>;
  created_at: string;
  /** present on PULL REQUESTS — GitHub returns them in the issues list */
  pull_request?: unknown;
}

export const isPullRequestRow = (row: Pick<GitHubIssueRow, "pull_request">): boolean => row.pull_request !== undefined;
