/**
 * Strategy id -> its surface, each behind React.lazy: a surface that fails to load or to render
 * takes down its own node body (the frame's error boundary), never the page or another strategy.
 */
import { type ComponentType, lazy, type LazyExoticComponent } from "react";

import type { SurfaceProps } from "../../notations/board/surface.ts";
import type { Strategy } from "../shared.ts";

export const SURFACES: Readonly<Record<Strategy, LazyExoticComponent<ComponentType<SurfaceProps>>>> = {
  naive: lazy(() => import("./naive.tsx").then((module) => ({ default: module.NaiveSurface }))),
  counter: lazy(() => import("./counter.tsx").then((module) => ({ default: module.CounterSurface }))),
  overlay: lazy(() => import("./overlay.tsx").then((module) => ({ default: module.OverlaySurface }))),
  iframe: lazy(() => import("./iframe.tsx").then((module) => ({ default: module.IframeSurface }))),
  plugin: lazy(() => import("./plugin.tsx").then((module) => ({ default: module.PluginSurface }))),
  shim: lazy(() => import("./shim.tsx").then((module) => ({ default: module.ShimSurface }))),
};
