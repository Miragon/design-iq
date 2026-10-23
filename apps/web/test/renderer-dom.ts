/**
 * Just enough browser for the REAL Miragon renderers under node --test: a
 * jsdom document on the globals, an SVG geometry without layout (diagram-js
 * moves every shape through SVG transforms and matrices, jsdom has none),
 * dialogs that open modal (jsdom has no showModal), and module hooks for
 * what only a bundler resolves (the renderers import
 * diagram-js subpaths without an extension, the specs' load() imports the
 * stylesheet, the SPA editors the "@/" alias and the bpmn editor its own
 * sources without one). Import it before any renderer, and import the renderers
 * dynamically: the hooks only see imports resolved after they register.
 * Every element reports one client size (CLIENT_SIZE), so a canvas has a
 * viewbox and a view state, but shapes measure 0×0: a fit can be asserted
 * only to a content box a renderer computes from its model
 * (`contentBounds()`), and nothing about label layout, only what the
 * renderers import, export, emit and keep as their view.
 */
import { registerHooks } from "node:module";

import { JSDOM } from "jsdom";

const SRC = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) return nextResolve(new URL(`${specifier.slice(2)}.ts`, SRC).href, context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error;
      if (/\.[cm]?[jt]s$/.test(specifier)) throw error;
      // a package's own .js first; the app's sources are .ts (the bpmn editor's relative imports)
      for (const suffix of [".js", "/index.js", ".ts", "/index.ts"]) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // the next suffix
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globals) continue;
  Object.defineProperty(globals, key, {
    value: (window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}

class Matrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  static of(values: Partial<Pick<Matrix, "a" | "b" | "c" | "d" | "e" | "f">>): Matrix {
    return Object.assign(new Matrix(), values);
  }
  multiply(m: Matrix): Matrix {
    return Matrix.of({
      a: this.a * m.a + this.c * m.b,
      b: this.b * m.a + this.d * m.b,
      c: this.a * m.c + this.c * m.d,
      d: this.b * m.c + this.d * m.d,
      e: this.a * m.e + this.c * m.f + this.e,
      f: this.b * m.e + this.d * m.f + this.f,
    });
  }
  inverse(): Matrix {
    const det = this.a * this.d - this.b * this.c || 1;
    return Matrix.of({
      a: this.d / det,
      b: -this.b / det,
      c: -this.c / det,
      d: this.a / det,
      e: (this.c * this.f - this.d * this.e) / det,
      f: (this.b * this.e - this.a * this.f) / det,
    });
  }
  translate(x: number, y: number): Matrix {
    return this.multiply(Matrix.of({ e: x, f: y }));
  }
  scale(s: number): Matrix {
    return this.multiply(Matrix.of({ a: s, d: s }));
  }
  rotate(): Matrix {
    return this.multiply(new Matrix());
  }
}

class Transform {
  type = 1;
  angle = 0;
  matrix = new Matrix();
  setMatrix(m: Matrix): void {
    this.matrix = m;
  }
  setTranslate(x: number, y: number): void {
    this.matrix = new Matrix().translate(x, y);
  }
  setScale(s: number): void {
    this.matrix = new Matrix().scale(s);
  }
  setRotate(): void {
    this.matrix = new Matrix();
  }
}

class TransformList {
  private items: Transform[] = [];
  get numberOfItems(): number {
    return this.items.length;
  }
  clear(): void {
    this.items = [];
  }
  initialize(t: Transform): Transform {
    this.items = [t];
    return t;
  }
  appendItem(t: Transform): Transform {
    this.items.push(t);
    return t;
  }
  getItem(i: number): Transform | undefined {
    return this.items[i];
  }
  createSVGTransformFromMatrix(m: Matrix): Transform {
    const t = new Transform();
    t.setMatrix(m);
    return t;
  }
  consolidate(): Transform | null {
    if (this.items.length === 0) return null;
    const t = this.createSVGTransformFromMatrix(this.items.reduce((m, item) => m.multiply(item.matrix), new Matrix()));
    this.items = [t];
    return t;
  }
}

const transforms = new WeakMap<object, TransformList>();
const element = window.SVGElement.prototype as unknown as Record<string, unknown>;
Object.defineProperty(element, "transform", {
  configurable: true,
  get(this: object) {
    let list = transforms.get(this);
    if (!list) transforms.set(this, (list = new TransformList()));
    return { baseVal: list };
  },
});
element.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 });
element.getCTM = () => new Matrix();
element.getScreenCTM = () => new Matrix();
element.getComputedTextLength = () => 0;
const svg = window.SVGSVGElement.prototype as unknown as Record<string, unknown>;
svg.createSVGMatrix = () => new Matrix();
svg.createSVGTransform = () => new Transform();
svg.createSVGTransformFromMatrix = (m: Matrix) => new TransformList().createSVGTransformFromMatrix(m);
svg.createSVGPoint = () => ({
  x: 0,
  y: 0,
  matrixTransform(this: { x: number; y: number }, m: Matrix) {
    return { x: m.a * this.x + m.c * this.y + m.e, y: m.b * this.x + m.d * this.y + m.f };
  },
});
globals.SVGMatrix = Matrix;

/** the renderers' dialogs open modal; jsdom has no showModal: open and close
 *  set the attribute (what `open` reads) and close fires its event */
const dialog = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
dialog.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
dialog.close ??= function (this: HTMLDialogElement) {
  if (!this.hasAttribute("open")) return;
  this.removeAttribute("open");
  this.dispatchEvent(new window.Event("close"));
};

/** the client size of every element — a canvas without one has no viewbox */
const CLIENT_SIZE = { width: 1000, height: 640 };
const htmlElement = window.HTMLElement.prototype;
Object.defineProperty(htmlElement, "clientWidth", { configurable: true, get: () => CLIENT_SIZE.width });
Object.defineProperty(htmlElement, "clientHeight", { configurable: true, get: () => CLIENT_SIZE.height });

/** a fresh host in the document, the way the editor and the widget mount a renderer */
export function host(className?: string): HTMLElement {
  const el = window.document.createElement("div");
  if (className) el.className = className;
  window.document.body.append(el);
  return el;
}

/** closes the window: its timers would keep the test process alive */
export function closeDom(): void {
  window.close();
}
