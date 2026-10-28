/**
 * What the renderers' menu content needs from designIQ, shared by the specs
 * that ship it (Wardley, Event Storming, Context Maps, Team Topologies, Value
 * Chain): the chrome their dialogs and popovers take (a modeler-shell handle's
 * shape, filled from the shell's own messages so the shortcut tables name the
 * zoom keys as the modelers do), dialogs built on first use and removed with the
 * mount, the modeler shell's Keyboard shortcuts… dialog, the image exports
 * (without the presence layer) and the text ones. Loaded with the renderer
 * (behind each spec's `load()`).
 */
import { CD } from "@designiq/ui-kit/lib/tokens";
import { type ShellDialog, type ShortcutGroup, showShortcutsDialog } from "@miragon/modeler-shell";
import { defaultMessages, detectPlatform, withChromeShortcuts } from "@miragon/modeler-shell/core";

import { withoutPresence } from "../../lib/presence-canvas.ts";
import type { ExportFile } from "../../mcp-app/core/engine.ts";
import type { MiragonMenuHost } from "./spec.ts";

/** designIQ's one UI language (UI copy stays English) */
export const MENU_LANG = "en";

/** what lies under the drawing in a PNG export (guide §10.7): the light plot
 *  for a notation drawn on one (Wardley), the light canvas ground for every other */
export const PNG_BACKGROUND = { plot: CD.weiss, ground: CD.grau } as const;

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

/** the document's own title for the menu header; the placeholder a parser
 *  fills in for a document without a title line ("Untitled Map") is none */
export function ownTitle(title: string | undefined, placeholder: string): string | undefined {
  const shown = title?.trim();
  return shown && shown !== placeholder ? shown : undefined;
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

export interface ShortcutsDialog {
  open(): void;
  /** closes an open one: it lives in the mount's host and goes with the mount */
  destroy(): void;
}

/**
 * Keyboard shortcuts… (guide §5.4, §8) on the modeler shell's dialog, which
 * opens without a mounted shell: inside the mount's host and centred over it,
 * with the renderer's groups as its pure shortcut table builds them. designIQ
 * binds the zoom and fit keys itself (lib/chrome-keys.ts), so the shell's rows
 * for them lead the View group, named and chipped as its tooltips show them.
 * The dialog is built on open and removed on close; the focus goes back to
 * where it was (the menu trigger in the widget), else to the trigger (the
 * SPA's menu entry is gone by then). Its look is the shell's sheet, which
 * each spec's `load()` brings with the renderer's.
 */
export function shortcutsDialog(
  host: MiragonMenuHost,
  groups: (chrome: ReturnType<typeof dialogChrome>) => readonly ShortcutGroup[],
): ShortcutsDialog {
  let shown: ShellDialog | undefined;
  return {
    open() {
      if (shown?.isOpen()) return;
      const chrome = dialogChrome(host);
      shown = showShortcutsDialog(withChromeShortcuts(groups(chrome), chrome), {
        container: host.root,
        focusFallback: () => host.trigger.focus(),
      });
    },
    destroy() {
      shown?.close();
      shown = undefined;
    },
  };
}

/** an export, named after the model's file */
function exportFile(host: MiragonMenuHost, extension: string, mimeType: string, data: Blob | string): ExportFile {
  return { name: `${host.fileStem()}.${extension}`, mimeType, data };
}

/** the Export group's PNG and SVG of a diagram, named after the model's file,
 *  both without the peers the live canvas shows */
export function imageExports(
  host: MiragonMenuHost,
  svg: () => Promise<string>,
  png: (svg: string) => Promise<Blob>,
): { png: { onSelect(): void }; svg: { onSelect(): void } } {
  const diagram = async (): Promise<string> => withoutPresence(await svg());
  return {
    png: {
      onSelect: () => void host.download(async () => exportFile(host, "png", "image/png", await png(await diagram()))),
    },
    svg: { onSelect: () => void host.download(async () => exportFile(host, "svg", "image/svg+xml", await diagram())) },
  };
}

/** the model in another text format (Context Mapper's CML), named after the
 *  model's file; written inside the download, so a model it cannot write
 *  reaches the host's failure report instead of throwing from the menu */
export function textExport(host: MiragonMenuHost, extension: string, write: () => string): { onSelect(): void } {
  return { onSelect: () => void host.download(async () => exportFile(host, extension, "text/plain", write())) };
}
