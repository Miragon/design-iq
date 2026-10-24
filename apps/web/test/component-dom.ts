/**
 * Just enough for the SPA's React components under node --test: the jsdom
 * document and module hooks of test/renderer-dom.ts, plus what only Vite
 * does for a component. A .tsx module (the app's components and the
 * ui-kit's) goes through TypeScript's transpiler, radix's events are
 * jsdom's, and its popper gets the ResizeObserver jsdom lacks. Import it
 * before any component, and import the components dynamically: the hooks
 * only see imports resolved after they register.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export { closeDom } from "./renderer-dom.ts";

const SRC = new URL("../src/", import.meta.url);
// Vite gives every app module an import.meta.env (lib/api.ts reads it at
// load); on the same line as the module's first, so line numbers hold
const VITE_ENV = "import.meta.env ??= {};";

registerHooks({
  // test/renderer-dom.ts resolves the "@/" alias to a .ts module only
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const component = new URL(`${specifier.slice(2)}.tsx`, SRC);
      if (existsSync(component)) return nextResolve(component.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) {
      const loaded = nextLoad(url, context);
      if (!url.startsWith(SRC.href)) return loaded;
      return { ...loaded, source: `${VITE_ENV}${String(loaded.source)}` };
    }
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    });
    return { format: "module", source: `${VITE_ENV}${outputText}`, shortCircuit: true };
  },
});

// node has an Event and a CustomEvent of its own, which renderer-dom.ts
// keeps; jsdom dispatches only its own, and radix creates CustomEvents
const window = document.defaultView!;
Object.assign(globalThis, { Event: window.Event, CustomEvent: window.CustomEvent });

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
