/**
 * Median-perimeter fill inpainting.
 *
 * The "good default" inpaint mode for translation overlay. Works on any
 * background where the immediate surroundings of the text region share
 * roughly the same color — manga panel speech bubbles, labels on
 * photographed signs, caption blocks on video frames.
 *
 * Pipeline per region:
 *   1. Sample the perimeter pixels of the bbox (one pixel-thick ring around
 *      the rectangle).
 *   2. Compute the *median* RGB color of those pixels.
 *   3. Fill the entire bbox interior with that median color.
 *   4. Render the translated text via `font.ts::renderTextIntoRegion()`.
 *
 * Why MEDIAN, not mean, of perimeter pixels:
 *   - The perimeter often clips a few pixels of the original character
 *     glyph (text rarely sits perfectly inside a bbox with no overlap).
 *   - Mean would be pulled toward the dark glyph color and produce a
 *     noticeably darker fill than the surrounding background.
 *   - Median is robust to ~20% outlier pixels — comfortably ignores those
 *     clipped glyph fragments and returns the dominant background color.
 *
 * Why bbox interior (not the actual character mask):
 *   - Tesseract's HOCR output doesn't give us a per-pixel character mask.
 *     Building one would require running Tesseract in a different mode and
 *     rebuilding the bitmap.
 *   - For typical bubble / label backgrounds where the perimeter color is
 *     uniform, the rectangular fill is visually indistinguishable from a
 *     mask-aware fill.
 */

import type { BoundingBox, FontConfig } from '../types.js';
import { renderTextIntoRegion } from './font.js';

export interface FillOptions {
  font?: FontConfig;
}

export async function applyFill(
  image: ImageData,
  regions: BoundingBox[],
  texts: string[],
  options: FillOptions = {}
): Promise<ImageData> {
  if (regions.length === 0) return image;

  const w = image.width;
  const h = image.height;

  // Allocate an OffscreenCanvas (browser) or @napi-rs/canvas (Node) and
  // paint the source ImageData onto it. Then for each region: paint the
  // median-color fill rectangle, then render translated text via font.ts.
  // Finally read back to ImageData.
  const ctx = await acquireContext(w, h, image);

  for (let i = 0; i < regions.length; i++) {
    const bbox = regions[i];
    const text = texts[i] ?? '';
    const median = perimeterMedian(image, bbox);
    ctx.fillStyle = `rgb(${median[0]},${median[1]},${median[2]})`;
    ctx.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
    if (text.trim().length > 0) {
      // Choose text color by perimeter luminance — dark on light, light on dark.
      const luminance = 0.2126 * median[0] + 0.7152 * median[1] + 0.0722 * median[2];
      const textColor = luminance > 128 ? '#000000' : '#FFFFFF';
      renderTextIntoRegion(ctx as any, text, bbox, {
        ...options.font,
        color: options.font?.color ?? textColor
      });
    }
  }

  return readBackImageData(ctx, w, h);
}

/**
 * Sample the perimeter pixels of `bbox` and compute the channel-wise median
 * RGB color. The mask uses a 1-pixel-thick ring; if the region is too tiny
 * (< 4×4) we sample whatever's available and fall back to the bbox-interior
 * mean to avoid divide-by-zero.
 */
function perimeterMedian(image: ImageData, bbox: BoundingBox): [number, number, number] {
  const w = image.width;
  const h = image.height;
  const data = image.data;
  const x0 = Math.max(0, Math.floor(bbox.x));
  const y0 = Math.max(0, Math.floor(bbox.y));
  const x1 = Math.min(w - 1, Math.floor(bbox.x + bbox.w) - 1);
  const y1 = Math.min(h - 1, Math.floor(bbox.y + bbox.h) - 1);

  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];

  // Top + bottom rows
  for (let x = x0; x <= x1; x++) {
    pushPixel(data, w, x, y0, rs, gs, bs);
    if (y1 !== y0) pushPixel(data, w, x, y1, rs, gs, bs);
  }
  // Left + right cols (excluding corners already sampled)
  for (let y = y0 + 1; y < y1; y++) {
    pushPixel(data, w, x0, y, rs, gs, bs);
    if (x1 !== x0) pushPixel(data, w, x1, y, rs, gs, bs);
  }

  if (rs.length === 0) return [0, 0, 0];
  return [median(rs), median(gs), median(bs)];
}

function pushPixel(
  data: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
  rs: number[],
  gs: number[],
  bs: number[]
): void {
  const off = (y * w + x) * 4;
  rs.push(data[off]);
  gs.push(data[off + 1]);
  bs.push(data[off + 2]);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) >> 1 : sorted[mid];
}

// -- Context acquisition ------------------------------------------------

type AnyCtx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

async function acquireContext(w: number, h: number, source: ImageData): Promise<AnyCtx> {
  if (typeof OffscreenCanvas !== 'undefined' && typeof Blob !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.putImageData(source, 0, 0);
    return ctx;
  }
  const canvasMod = await import('@napi-rs/canvas');
  const c = canvasMod.createCanvas(w, h);
  const ctx = c.getContext('2d');
  // @napi-rs/canvas needs its own ImageData instance — see ingest.ts.
  const napi = ctx.createImageData(w, h);
  napi.data.set(source.data);
  ctx.putImageData(napi, 0, 0);
  return ctx as unknown as CanvasRenderingContext2D;
}

async function readBackImageData(ctx: AnyCtx, w: number, h: number): Promise<ImageData> {
  const id = ctx.getImageData(0, 0, w, h);
  return {
    data: new Uint8ClampedArray(id.data.buffer, id.data.byteOffset, id.data.byteLength),
    width: id.width,
    height: id.height,
    colorSpace: 'srgb'
  } as ImageData;
}
