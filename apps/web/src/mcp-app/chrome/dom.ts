/**
 * The one element builder the chrome modules share — the widgets carry no
 * framework, and `createElement` + attributes + children is all they build.
 */

/** `h("button", { class: "pb", type: "button" }, icon("x"), "Dismiss")` —
 *  `class` sets className, every other key an attribute; undefined children skip */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== undefined) node.append(c);
  return node;
}

/** a status dot — chrome.css `.dot.<live|dirty|bad|warn|info>`; decorative,
 *  the words beside it carry the meaning (colour is never the only signal) */
export const dot = (cls: string): HTMLElement => h("span", { class: `dot ${cls}`, "aria-hidden": "true" });
