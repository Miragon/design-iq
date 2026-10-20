/**
 * The SPA's scoping of a Miragon renderer stylesheet (vite.config.ts): the
 * sheets restyle GLOBAL diagram-js classes (.djs-palette etc.), and loaded
 * once through a lazy editor chunk they would re-theme the bpmn-js and
 * dmn-js editors of the same session for good. Each rule is prefixed with
 * the spec's canvas host class at build time. A selector starting with
 * :root stays global: the sheets declare their custom properties there.
 * Which selectors that leaves global per renderer is pinned in
 * test/vendor-css.test.ts, so a bump that adds one shows up in review.
 *
 * Each renderer also adds its own root class (`vendorRoot`) to the SAME
 * element that carries the scope class, so a descendant prefix would never
 * match those selectors: they get the scope as a compound instead
 * (.wardley-canvas.wardley-container …).
 *
 * Node-loadable (vite.config.ts and the node suites import it): no DOM, no
 * "@/" alias.
 */
import type { MiragonRendererSpec } from "./spec.ts";

/** the options of postcss-prefix-selector for one renderer's stylesheet */
export interface VendorCssScoping {
  prefix: string;
  includeFiles: RegExp[];
  transform(scope: string, selector: string, prefixed: string): string;
}

export function vendorCssScoping(
  spec: Pick<MiragonRendererSpec, "pkg" | "canvasClassName" | "vendorRoot">,
): VendorCssScoping {
  const vendorRoot = `.${spec.vendorRoot}`;
  return {
    prefix: `.${spec.canvasClassName}`,
    includeFiles: [vendorSheetOf(spec.pkg)],
    transform(scope, selector, prefixed) {
      if (selector.startsWith(":root")) return selector;
      const rest = selector.slice(vendorRoot.length);
      if (selector.startsWith(vendorRoot) && /^($|[ .:,>~+[])/.test(rest)) return scope + selector;
      return prefixed;
    },
  };
}

/** the package's files under node_modules — pnpm's store spells the scope
 *  separator as "+" (node_modules/.pnpm/@miragon+wardley-renderer@…) */
export function vendorSheetOf(pkg: string): RegExp {
  return new RegExp(pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("/", "[/+]"));
}
