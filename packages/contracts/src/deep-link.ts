/**
 * Web-app deep links — the doorway INTO designIQ's own editor routes (the mirror
 * of assist.ts, which leads OUT into an AI chat). The URL shapes live in ONE
 * place because three surfaces build them: the Live Host's `open_modeler` /
 * `open_decision_modeler` results, the GitHub issue bodies
 * (adapters/github/issues.ts) and the MCP modeler widgets' "Open in designIQ"
 * button — hand-rolled copies would drift.
 *
 * The repo segment splits at the FIRST slash: GitHub is always owner/name;
 * GitLab subgroups (multi-segment repos) need the router to capture the repo
 * as a splat first — mirror of the comment in apps/web/src/router.tsx.
 */

const repoBase = (publicUrl: string, repoFullName: string): string => {
  const slash = repoFullName.indexOf("/");
  const owner = slash === -1 ? repoFullName : repoFullName.slice(0, slash);
  const repo = slash === -1 ? "" : repoFullName.slice(slash + 1);
  return `${publicUrl.replace(/\/+$/, "")}/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
};

/** the repository overview: `/r/<owner>/<repo>` — the widgets' fallback when
 *  a load failed before the read resolved a path */
export function repoDeepLink(publicUrl: string, repoFullName: string): string {
  return repoBase(publicUrl, repoFullName);
}

/** the process editor: `/r/<owner>/<repo>/p/<processId>`, optionally revealing
 *  one element (`?element=` — validated by the route, unknown ids ignored) */
export function processDeepLink(
  publicUrl: string,
  repoFullName: string,
  processId: string,
  elementId?: string,
): string {
  const url = `${repoBase(publicUrl, repoFullName)}/p/${encodeURIComponent(processId)}`;
  return elementId ? `${url}?element=${encodeURIComponent(elementId)}` : url;
}

/** the file editor (any model file, e.g. a decision's .dmn):
 *  `/r/<owner>/<repo>/f/<repo-relative path>` — encoded per segment so the
 *  slashes keep separating the splat route's segments — optionally revealing
 *  one element (`?element=`, as on the process route) */
export function fileDeepLink(publicUrl: string, repoFullName: string, path: string, elementId?: string): string {
  const splat = path.split("/").map(encodeURIComponent).join("/");
  const url = `${repoBase(publicUrl, repoFullName)}/f/${splat}`;
  return elementId ? `${url}?element=${encodeURIComponent(elementId)}` : url;
}

/** the editor of a model a todo is anchored to: a process opens on its
 *  process route, a model of any other notation on the file route (and,
 *  without a file to open, the repository overview) */
export function modelDeepLink(
  publicUrl: string,
  repoFullName: string,
  model: { notation: string; id: string; file: string | null },
  elementId?: string,
): string {
  if (model.notation === "bpmn") return processDeepLink(publicUrl, repoFullName, model.id, elementId);
  return model.file
    ? fileDeepLink(publicUrl, repoFullName, model.file, elementId)
    : repoDeepLink(publicUrl, repoFullName);
}
