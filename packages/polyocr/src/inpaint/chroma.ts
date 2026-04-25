/**
 * Chroma-key inpainting.
 *
 * The caller pre-marks regions to inpaint by painting them a chroma color
 * (default `#FF00FF` — magenta is the conventional choice because it's
 * almost never present in natural images, so false-positive matches are
 * rare).
 *
 * Pipeline:
 *   1. `extractChromaMask(image, key, tolerance)` (in `ingest.ts`) extracts
 *      `MaskRegion[]` — each region is a bbox + a packed pixel mask of
 *      which pixels matched the chroma color within `tolerance`.
 *   2. For each masked region: sample non-masked perimeter pixels →
 *      median color → fill the masked pixels (NOT the bbox interior) with
 *      that color. The mask shape may be irregular; we paint only the
 *      pixels that match.
 *   3. Render translated text via `font.ts::renderTextIntoRegion()` on the
 *      bbox.
 *
 * Why chroma over auto-detect: when the user *knows* exactly what they want
 * inpainted (e.g. a designer marking specific text balloons in a manga
 * page in Photoshop before automation), painting a magenta mask is more
 * reliable than any detector. The OCR step is skipped for chroma-only mode
 * — the caller provides translations directly via `texts[]`.
 */

import type { MaskRegion, FontConfig } from '../types.js';
import { renderTextIntoRegion } from './font.js';

export interface ChromaOptions {
  font?: FontConfig;
}

export async function applyChroma(
  image: ImageData,
  masks: MaskRegion[],
  texts: string[],
  options: ChromaOptions = {}
): Promise<ImageData> {
  if (masks.length === 0) return image;
  const w = image.width;
  const h = image.height;
  const ctx = await acquireContext(w, h, image);

  for (let i = 0; i < masks.length; i++) {
    const region = masks[i];
    const text = texts[i] ?? '';
    const median = nonMaskedPerimeterMedian(image, region);
    fillMaskShape(ctx, image, region, median);
    if (text.trim().length > 0) {
      const luminance = 0.2126 * median[0] + 0.7152 * median[1] + 0.0722 * median[2];
      const textColor = luminance > 128 ? '#000000' : '#FFFFFF';
      renderTextIntoRegion(ctx as any, text, region.bbox, {
        ...options.font,
        color: options.font?.color ?? textColor
      });
    }
  }
  return readBackImageData(ctx, w, h);
}

/**
 * Sample the perimeter of the mask's bbox EXCLUDING any pixels that are
 * themselves masked. The masked pixels are the ones we're trying to paint
 * over — sampling them defeats the purpose.
 *
 * If every perimeter pixel happens to be masked (a fully-masked region
 * touching the edge of the image), fall back to a small ring outside the
 * bbox.
 */
function nonMaskedPerimeterMedian(image: ImageData, region: MaskRegion): [number, number, number] {
  const { bbox, mask } = region;
  const w = image.width;
  const h = image.height;
  const data = image.data;

  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];

  // Walk the bbox perimeter in image space; skip pixels that are masked.
  const x0 = Math.max(0, Math.floor(bbox.x));
  const y0 = Math.max(0, Math.floor(bbox.y));
  const x1 = Math.min(w - 1, Math.floor(bbox.x + bbox.w) - 1);
  const y1 = Math.min(h - 1, Math.floor(bbox.y + bbox.h) - 1);

  const masked = (x: number, y: number): boolean => {
    const lx = x - bbox.x;
    const ly = y - bbox.y;
    if (lx < 0 || ly < 0 || lx >= bbox.w || ly >= bbox.h) return false;
    return mask[ly * bbox.w + lx] > 0;
  };

  for (let x = x0; x <= x1; x++) {
    if (!masked(x, y0)) pushPixel(data, w, x, y0, rs, gs, bs);
    if (y1 !== y0 && !masked(x, y1)) pushPixel(data, w, x, y1, rs, gs, bs);
  }
  for (let y = y0 + 1; y < y1; y++) {
    if (!masked(x0, y)) pushPixel(data, w, x0, y, rs, gs, bs);
    if (x1 !== x0 && !masked(x1, y)) pushPixel(data, w, x1, y, rs, gs, bs);
  }

  // Fallback: ring just outside the bbox.
  if (rs.length === 0) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      if (x >= 0 && x < w) {
        if (y0 - 1 >= 0) pushPixel(data, w, x, y0 - 1, rs, gs, bs);
        if (y1 + 1 < h) pushPixel(data, w, x, y1 + 1, rs, gs, bs);
      }
    }
  }
  if (rs.length === 0) return [0, 0, 0];
  return [median(rs), median(gs), median(bs)];
}

/**
 * Paint the median color onto ONLY the pixels covered by the mask. Walks
 * the mask's local pixel grid and translates each masked pixel back to
 * image space.
 */
function fillMaskShape(
  ctx: AnyCtx,
  _image: ImageData,
  region: MaskRegion,
  color: [number, number, number]
): void {
  const { bbox, mask } = region;
  // For mask shapes that are large, doing pixel-by-pixel on the canvas
  // context is slow. We allocate a small ImageData covering the bbox,
  // paint the median color into masked pixels, leave others transparent,
  // and `putImageData` once.
  const local = ctx.createImageData(bbox.w, bbox.h);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) {
      const off = i * 4;
      local.data[off] = color[0];
      local.data[off + 1] = color[1];
      local.data[off + 2] = color[2];
      local.data[off + 3] = 255;
    }
  }
  // putImageData replaces pixels (it doesn't blend with alpha — that's why
  // we set α=255 only for masked pixels and leave others as 0).
  // To preserve the underlying source where mask=0, we composite via a
  // tiny temp canvas. For the masked pixels, we drawImage of the temp
  // onto the main ctx (default source-over), so non-masked transparent
  // pixels don't overwrite the source.
  drawCompositeReplacement(ctx, local, bbox.x, bbox.y);
}

function drawCompositeReplacement(
  ctx: AnyCtx,
  patch: ImageData,
  dx: number,
  dy: number
): void {
  // Path 1: OffscreenCanvas with alpha-aware drawImage via an intermediate.
  if (typeof OffscreenCanvas !== 'undefined' && (ctx as any).canvas instanceof OffscreenCanvas) {
    const tmp = new OffscreenCanvas(patch.width, patch.height);
    const tctx = tmp.getContext('2d') as OffscreenCanvasRenderingContext2D;
    tctx.putImageData(patch, 0, 0);
    ctx.drawImage(tmp as any, dx, dy);
    return;
  }
  // Path 2: Node — @napi-rs/canvas. The patch's `data` is a regular
  // Uint8ClampedArray we can copy into a per-call createImageData.
  const napi = ctx.createImageData(patch.width, patch.height);
  napi.data.set(patch.data);
  // Read back the existing area, blend manually, write back.
  const dest = ctx.getImageData(dx, dy, patch.width, patch.height);
  for (let i = 0; i < napi.data.length; i += 4) {
    if (napi.data[i + 3] > 0) {
      dest.data[i] = napi.data[i];
      dest.data[i + 1] = napi.data[i + 1];
      dest.data[i + 2] = napi.data[i + 2];
      dest.data[i + 3] = 255;
    }
  }
  ctx.putImageData(dest, dx, dy);
}

// -- Shared helpers -----------------------------------------------------

type AnyCtx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

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
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) >> 1 : sorted[mid];
}

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
