/**
 * A diagram's standalone SVG as a PNG, for the Export as PNG entries of the
 * Miragon renderers (Wardley, Event Storming, Context Maps), its labels in
 * Geist (lib/export-font.ts). The SVG loads as a data URL: a widget's content
 * security policy may refuse blob: images, which Wardley's own `svgToPng`
 * would load.
 */
import { CD } from "@designiq/ui-kit/lib/tokens";

import { embedGeist } from "./export-font.ts";

/** the guide's export density (§10.7: crisp on a slide), lowered where the
 *  browser would refuse a canvas that large */
const SCALE = 2;
const MAX_SIDE = 16_384;
const MAX_AREA = 16_384 * 16_384;

/** what lies under the drawing in the PNG (guide §10.7): the light plot for a
 *  notation drawn on one (Wardley), the light canvas ground for every other */
export const PNG_BACKGROUND = { plot: CD.weiss, ground: CD.grau } as const;

export interface PngOptions {
  /** what lies under the SVG: the canvas ground unless the notation draws on a plot */
  background?: string;
}

function svgSize(svg: string): { width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  if (width > 0 && height > 0) return { width, height };
  const box = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! };
  throw new Error("the diagram's SVG has no size");
}

/** a PNG in the system sans beats no PNG */
async function inGeist(svg: string): Promise<string> {
  try {
    return await embedGeist(svg);
  } catch (error) {
    console.warn("The PNG export falls back to the system sans:", error);
    return svg;
  }
}

export async function svgToPng(svg: string, { background = PNG_BACKGROUND.ground }: PngOptions = {}): Promise<Blob> {
  const { width, height } = svgSize(svg);
  const scale = Math.min(SCALE, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await inGeist(svg))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("this browser cannot draw the PNG");
  // the guide's light export (§10.7)
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the PNG could not be encoded"))), "image/png"),
  );
}
