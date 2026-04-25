/**
 * Input normalization. Every public entry point that accepts an image runs the
 * input through `normalize()` first, which dispatches on the input's runtime type
 * and produces a uniform `ImageData` for the rest of the pipeline.
 *
 * Each input shape requires different handling:
 *   - `File`/`Blob`         → `createImageBitmap` → drawn onto OffscreenCanvas
 *   - `HTMLImageElement`    → drawn onto canvas using `naturalWidth/Height`
 *   - `HTMLCanvasElement`   → direct `getContext('2d').getImageData(0, 0, w, h)`
 *   - `OffscreenCanvas`     → direct
 *   - `ImageData`           → pass-through (the common case after the first ingest)
 *   - `ArrayBuffer`         → wrap in `Blob` then `createImageBitmap`
 *   - `string` (path)       → Node-only: `fs.readFile` → Buffer → Blob
 *   - `string` (data URL)   → decode base64 portion → Blob
 *   - `string` (base64)     → decode → Blob
 */

import type { PolyOCRInput, MaskRegion, BoundingBox } from './types.js';
import { PolyOCRError } from './types.js';

/**
 * Detect whether we're running in a Node main process (no `window`, no DOM).
 * Workers in either environment have `self` but no `window`. We use the more
 * specific test `typeof process !== 'undefined' && process.versions?.node`
 * because that's true in Node main *and* `node:worker_threads` workers — both
 * of which need the Node-specific code paths.
 */
const IS_NODE = typeof process !== 'undefined' && !!(process as any).versions?.node;

/**
 * Normalize any accepted input to `ImageData`.
 *
 * The function is intentionally a long switch on runtime type — there's no
 * cleaner abstraction because each input shape requires genuinely different
 * decoding logic. Inline comments on each branch explain *why* that branch
 * needs the steps it does.
 */
export async function normalize(input: PolyOCRInput): Promise<ImageData> {
  // Pass-through — this is the common case once the pipeline has already
  // ingested an image and is passing it between stages.
  if (isImageData(input)) return input;

  if (typeof input === 'string') {
    // Strings are ambiguous — could be a filesystem path, a data URL, or a
    // bare base64 blob. The order of the checks matters: data URL has the
    // most distinctive prefix, then base64 (heuristic: long string of
    // [A-Za-z0-9+/=]), and finally fall through to filesystem path.
    if (input.startsWith('data:')) {
      return await fromDataUrl(input);
    }
    if (looksLikeBase64(input)) {
      return await fromBase64(input);
    }
    if (IS_NODE) {
      return await fromFilePath(input);
    }
    throw new PolyOCRError(
      'INVALID_INPUT',
      `Cannot resolve string input in browser context (not a data URL): ${input.slice(0, 64)}...`
    );
  }

  if (input instanceof ArrayBuffer) {
    // ArrayBuffer needs to go through Blob first because `createImageBitmap`
    // (and the Node-side image decoder) don't accept raw bytes — they need a
    // type tag that `Blob` provides. We don't know the actual MIME type so
    // we pass `image/*` and let the decoder sniff the magic bytes.
    return await fromBlob(new Blob([input], { type: 'image/*' }));
  }

  // Browser-only shapes from here down. Order matters: ImageBitmap doesn't
  // exist in Node by default; HTMLImageElement / HTMLCanvasElement / File /
  // Blob exist only in browser / Electron renderer.
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return await fromBlob(input);
  }

  if (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas) {
    return offscreenCanvasToImageData(input);
  }

  if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
    return canvasToImageData(input);
  }

  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    return imageElementToImageData(input);
  }

  throw new PolyOCRError(
    'INVALID_INPUT',
    `Unrecognized input type: ${Object.prototype.toString.call(input)}`
  );
}

/**
 * Type guard for ImageData. We can't `instanceof ImageData` everywhere because
 * the global isn't always available in Node — duck-type instead.
 */
function isImageData(x: unknown): x is ImageData {
  return (
    typeof x === 'object' &&
    x !== null &&
    'data' in x &&
    'width' in x &&
    'height' in x &&
    (x as ImageData).data instanceof Uint8ClampedArray
  );
}

/**
 * Heuristic: a base64 image is at minimum a few hundred chars and uses only
 * the base64 alphabet. We reject very short strings (likely a path) and
 * anything containing path separators.
 */
function looksLikeBase64(s: string): boolean {
  if (s.length < 100) return false;
  if (s.includes('/') || s.includes('\\')) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(s);
}

async function fromDataUrl(url: string): Promise<ImageData> {
  // `data:image/png;base64,...` — split on the comma, strip the prefix.
  const comma = url.indexOf(',');
  if (comma < 0) {
    throw new PolyOCRError('INVALID_INPUT', 'Malformed data URL');
  }
  const meta = url.slice(0, comma);
  const body = url.slice(comma + 1);
  const isBase64 = meta.includes(';base64');
  const bytes = isBase64 ? base64ToBytes(body) : new TextEncoder().encode(decodeURIComponent(body));
  const mime = meta.match(/^data:([^;,]+)/)?.[1] ?? 'image/*';
  return await fromBlob(new Blob([bytes as BlobPart], { type: mime }));
}

async function fromBase64(b64: string): Promise<ImageData> {
  const cleaned = b64.replace(/\s+/g, '');
  return await fromBlob(new Blob([base64ToBytes(cleaned) as BlobPart], { type: 'image/*' }));
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function fromFilePath(path: string): Promise<ImageData> {
  // Dynamic import keeps the browser bundle clean.
  const fs = await import('node:fs/promises');
  const buf = await fs.readFile(path);
  // The `canvas` package exposes `loadImage` which sniffs the MIME type from
  // the file's magic bytes. Going through Blob would also work but adds a
  // copy.
  const blob = new Blob([buf], { type: 'image/*' });
  return await fromBlob(blob);
}

async function fromBlob(blob: Blob): Promise<ImageData> {
  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
    // Browser / worker / modern Electron renderer path.
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PolyOCRError('INGEST_FAILED', 'Could not acquire 2D context for OffscreenCanvas');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  }

  if (IS_NODE) {
    return await fromBlobNode(blob);
  }

  throw new PolyOCRError(
    'INGEST_FAILED',
    'Environment provides neither createImageBitmap nor a Node canvas polyfill'
  );
}

/**
 * Node fallback using `@napi-rs/canvas` — a Rust-backed canvas implementation
 * with prebuilt binaries for every modern Node target (no node-gyp required,
 * unlike the legacy `canvas` package). We import dynamically so the package
 * still loads in browsers / edge runtimes where the native module isn't
 * available.
 */
async function fromBlobNode(blob: Blob): Promise<ImageData> {
  let canvasMod: typeof import('@napi-rs/canvas');
  try {
    canvasMod = await import('@napi-rs/canvas');
  } catch {
    throw new PolyOCRError(
      'INGEST_FAILED',
      'Node canvas polyfill is required for non-ImageData inputs but `@napi-rs/canvas` is not installed. Run `npm install @napi-rs/canvas`.'
    );
  }
  const arrayBuffer = await blob.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  const img = await canvasMod.loadImage(buf);
  const c = canvasMod.createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img as any, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  // @napi-rs/canvas's ImageData has a `Uint8ClampedArray` already; we still
  // re-wrap so we can attach the standard `colorSpace` field for downstream
  // typing.
  return {
    data: new Uint8ClampedArray(id.data.buffer, id.data.byteOffset, id.data.byteLength),
    width: id.width,
    height: id.height,
    colorSpace: 'srgb'
  } as ImageData;
}

function offscreenCanvasToImageData(c: OffscreenCanvas): ImageData {
  const ctx = c.getContext('2d');
  if (!ctx) throw new PolyOCRError('INGEST_FAILED', 'Could not acquire 2D context for OffscreenCanvas');
  return ctx.getImageData(0, 0, c.width, c.height);
}

function canvasToImageData(c: HTMLCanvasElement): ImageData {
  const ctx = c.getContext('2d');
  if (!ctx) throw new PolyOCRError('INGEST_FAILED', 'Could not acquire 2D context for HTMLCanvasElement');
  return ctx.getImageData(0, 0, c.width, c.height);
}

function imageElementToImageData(img: HTMLImageElement): ImageData {
  // We use naturalWidth/Height because the element may be CSS-scaled — we want
  // the image's intrinsic dimensions for OCR.
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) {
    throw new PolyOCRError('INGEST_FAILED', 'HTMLImageElement has no natural dimensions (not loaded?)');
  }
  const c: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : (() => {
          const el = document.createElement('canvas');
          el.width = w;
          el.height = h;
          return el;
        })();
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new PolyOCRError('INGEST_FAILED', 'Could not acquire 2D context');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Extract chroma-keyed mask regions from an image.
 *
 * Walks every pixel and tags those within `tolerance` RGB-distance of `key`.
 * Connected runs of tagged pixels become `MaskRegion[]` via a BFS flood-fill.
 *
 * `tolerance` is measured in 0..255 per-channel L2 distance. Default 16 (the
 * caller passes the actual default in OcrOptions).
 *
 * Why we need this at the ingest stage rather than as part of inpaint mode:
 * the chroma extraction is cheap to run once and produces both the bbox list
 * (which the OCR stage may want to skip — there's no text to recognize in
 * masked regions; the caller is providing translations directly) AND the
 * pixel mask (which the inpaint stage needs to fill the right shape, not
 * just the bbox).
 */
export function extractChromaMask(
  imageData: ImageData,
  key: string,
  tolerance: number
): MaskRegion[] {
  const [kR, kG, kB] = parseHexColor(key);
  const tol2 = tolerance * tolerance;
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;

  // First pass — produce a packed byte-per-pixel mask of which pixels match.
  // We use Uint8Array (not boolean array) so the BFS below can mark visited
  // pixels in-place by setting them to 0.
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const dr = data[i] - kR;
    const dg = data[i + 1] - kG;
    const db = data[i + 2] - kB;
    if (dr * dr + dg * dg + db * db <= tol2) {
      mask[p] = 1;
    }
  }

  // BFS-flood-fill over the mask to extract connected components. For each
  // component we track the bbox extents and copy out the per-region mask.
  const regions: MaskRegion[] = [];
  const queue = new Int32Array(mask.length);
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== 1) continue;
    let qHead = 0, qTail = 0;
    queue[qTail++] = p;
    mask[p] = 2; // mark visited
    let minX = w, minY = h, maxX = 0, maxY = 0;
    const componentPixels: number[] = [];
    while (qHead < qTail) {
      const idx = queue[qHead++];
      componentPixels.push(idx);
      const x = idx % w;
      const y = (idx - x) / w;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      // 4-connectivity neighbors. 8-connectivity would catch slightly more
      // diagonals but in practice chroma keys are drawn with anti-aliased
      // edges so the difference is negligible.
      if (x > 0 && mask[idx - 1] === 1) { mask[idx - 1] = 2; queue[qTail++] = idx - 1; }
      if (x < w - 1 && mask[idx + 1] === 1) { mask[idx + 1] = 2; queue[qTail++] = idx + 1; }
      if (y > 0 && mask[idx - w] === 1) { mask[idx - w] = 2; queue[qTail++] = idx - w; }
      if (y < h - 1 && mask[idx + w] === 1) { mask[idx + w] = 2; queue[qTail++] = idx + w; }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // Skip components smaller than a sensible minimum (4x4) — those are usually
    // chroma key bleed at glyph edges, not intentional masks.
    if (bw < 4 || bh < 4) continue;
    const regionMask = new Uint8ClampedArray(bw * bh);
    for (const idx of componentPixels) {
      const x = idx % w;
      const y = (idx - x) / w;
      regionMask[(y - minY) * bw + (x - minX)] = 255;
    }
    const bbox: BoundingBox = { x: minX, y: minY, w: bw, h: bh };
    regions.push({ bbox, mask: regionMask });
  }

  return regions;
}

function parseHexColor(hex: string): [number, number, number] {
  const m = hex.replace(/^#/, '');
  if (m.length !== 6) {
    throw new PolyOCRError('INVALID_OPTIONS', `Invalid chroma key color: ${hex}`);
  }
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
