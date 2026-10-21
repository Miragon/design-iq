/**
 * Links a renderer puts into the canvas (a dialog's or a popover's "Learn
 * Wardley Mapping"). The widget's sandbox blocks the new window such a link
 * asks for, and a link without a target would replace the widget itself, so
 * every web link in the canvas goes through the host (shell.ts openExternal).
 */

/** the web address a primary click on a link opens; undefined for any other click */
export function externalLinkOf(event: MouseEvent): string | undefined {
  if (event.defaultPrevented || event.button !== 0) return undefined;
  const target = event.target as Element | null;
  const link = typeof target?.closest === "function" ? target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link) return undefined;
  const url = link.href;
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** every web link clicked inside `scope` goes to `open` instead; returns the unbind */
export function mountExternalLinks(scope: HTMLElement, open: (url: string) => void): () => void {
  const onClick = (event: MouseEvent): void => {
    const url = externalLinkOf(event);
    if (!url) return;
    event.preventDefault();
    open(url);
  };
  scope.addEventListener("click", onClick);
  return () => scope.removeEventListener("click", onClick);
}
