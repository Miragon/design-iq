/**
 * A diagram's standalone SVG as a PNG, for the Export as PNG entries of the
 * renderers that bring no rasterizer of their own (Event Storming, Context
 * Maps; Wardley ships `svgToPng`). The SVG loads as a data URL: a widget's
 * content security policy may refuse blob: images.
 */
import { CD } from "@designiq/ui-kit/lib/tokens";

/** the guide's export density (§10.7: crisp on a slide), lowered where the
 *  browser would refuse a canvas that large */
const SCALE = 2;
const MAX_SIDE = 16_384;
const MAX_AREA = 16_384 * 16_384;

function svgSize(svg: string): { width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  if (width > 0 && height > 0) return { width, height };
  const box = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! };
  throw new Error("the diagram's SVG has no size");
}

export async function svgToPng(svg: string): Promise<Blob> {
  const { width, height } = svgSize(svg);
  const scale = Math.min(SCALE, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("this browser cannot draw the PNG");
  // the guide's light export (§10.7): the plot's white under a transparent SVG
  context.fillStyle = CD.weiss;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the PNG could not be encoded"))), "image/png"),
  );
}
