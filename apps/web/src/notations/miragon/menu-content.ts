/**
 * What the renderers' menu content needs from designIQ, shared by the specs
 * that ship it (Wardley, Event Storming, Context Maps): the chrome their
 * dialogs and popovers take — a modeler-shell handle's shape, filled from
 * the shell's own messages so the shortcut tables name the zoom keys as the
 * modelers do —, dialogs built on first use and removed with the mount, and
 * the image exports. Loaded with the renderer (behind each spec's `load()`).
 */
import { defaultMessages, detectPlatform } from "@miragon/modeler-shell/core";

import type { ExportFile } from "../../mcp-app/core/engine.ts";
import type { MiragonMenuHost } from "./spec.ts";

/** designIQ's one UI language (UI copy stays English) */
export const MENU_LANG = "en";

/** the chrome the renderers' dialogs, popovers and shortcut tables take */
export function dialogChrome(host: MiragonMenuHost) {
  return {
    root: host.root,
    // read when a dialog closes: the SPA's menu trigger re-renders
    menu: {
      get trigger(): HTMLElement {
        return host.trigger;
      },
    },
    // the machine the user sits at decides the chips (guide §5.8)
    platform: detectPlatform(globalThis.navigator),
    lang: MENU_LANG,
    messages: defaultMessages,
  };
}

export interface Lazy<T> {
  get(): T;
  destroy(): void;
}

/** a dialog or popover is built when it first opens, and only then needs removing */
export function lazily<T extends { destroy(): void }>(make: () => T): Lazy<T> {
  let made: T | undefined;
  return {
    get: () => (made ??= make()),
    destroy() {
      made?.destroy();
      made = undefined;
    },
  };
}

/** the Export group's PNG and SVG of a diagram, named after the model's file */
export function imageExports(
  host: MiragonMenuHost,
  svg: () => Promise<string>,
  png: (svg: string) => Promise<Blob>,
): { png: { onSelect(): void }; svg: { onSelect(): void } } {
  const file = (extension: string, mimeType: string, data: Blob | string): ExportFile => ({
    name: `${host.fileStem()}.${extension}`,
    mimeType,
    data,
  });
  return {
    png: { onSelect: () => void host.download(async () => file("png", "image/png", await png(await svg()))) },
    svg: { onSelect: () => void host.download(async () => file("svg", "image/svg+xml", await svg())) },
  };
}
