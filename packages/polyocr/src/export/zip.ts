/**
 * ZIP exporter — bundles multiple content types into a single archive.
 *
 * Uses `jszip` (no native deps; runs in browser + Node).
 *
 * `ExportOptions.zip.include` selects what goes in:
 *   - 'images' — each `result.inpaintedImage` re-encoded to PNG or WebP and
 *                written as `images/0001.png`, `images/0002.png`, ...
 *                (4-digit zero-pad — sorts correctly in any file manager).
 *   - 'csv'    — full CSV at `results.csv`.
 *   - 'json'   — full JSON at `results.json`.
 *   - 'txt'    — one text file per result at `text/0001.txt`, ...
 *
 * `imageFormat`: PNG (lossless, larger) or WebP (lossy quality=92, ~5x
 * smaller). PNG is the default — it round-trips inpainted output exactly.
 *
 * `manifest: true` adds `manifest.json` describing what's in the zip and
 * the options used, so a downstream tool doesn't have to guess the layout.
 */

import type { ProcessResult, ExportOptions } from '../types.js';
import { toCsv } from './csv.js';

export interface ZipOutput {
  /** Buffer in Node, Blob in browser. */
  data: Buffer | Blob;
  /** Suggested filename. */
  filename: string;
}

export async function toZip(results: ProcessResult[], options: ExportOptions): Promise<ZipOutput> {
  const include = new Set(options.zip?.include ?? ['json', 'csv']);
  const imageFormat = options.zip?.imageFormat ?? 'png';
  const wantManifest = options.zip?.manifest !== false;

  const JSZipMod = await import('jszip');
  const JSZip = (JSZipMod as any).default ?? JSZipMod;
  const zip = new JSZip();

  if (include.has('json')) {
    zip.file('results.json', JSON.stringify(stripBinary(results), null, 2));
  }
  if (include.has('csv')) {
    zip.file('results.csv', toCsv(results, options));
  }
  if (include.has('txt')) {
    for (const r of results) {
      const text = (r.translation ?? r.text ?? '').trimEnd() + '\n';
      zip.file(`text/${pad(r.index + 1, 4)}.txt`, text);
    }
  }
  if (include.has('images')) {
    for (const r of results) {
      if (!r.inpaintedImage) continue;
      const ext = imageFormat;
      const png = await encodeImage(r.inpaintedImage, imageFormat);
      zip.file(`images/${pad(r.index + 1, 4)}.${ext}`, png);
    }
  }
  if (wantManifest) {
    zip.file(
      'manifest.json',
      JSON.stringify(
        {
          polyocrVersion: '0.1.0',
          exportedAt: new Date().toISOString(),
          count: results.length,
          options,
          files: {
            json: include.has('json') ? 'results.json' : null,
            csv: include.has('csv') ? 'results.csv' : null,
            images: include.has('images')
              ? results.filter((r) => r.inpaintedImage).map((r) => `images/${pad(r.index + 1, 4)}.${imageFormat}`)
              : null,
            text: include.has('txt')
              ? results.map((r) => `text/${pad(r.index + 1, 4)}.txt`)
              : null
          }
        },
        null,
        2
      )
    );
  }

  // Pick the right output type per runtime. JSZip's `generateAsync` accepts
  // both 'nodebuffer' and 'blob' as the `type` option.
  if (typeof Blob !== 'undefined' && typeof process === 'undefined') {
    const blob = await zip.generateAsync({ type: 'blob' });
    return { data: blob as Blob, filename: 'polyocr-export.zip' };
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return { data: buf as Buffer, filename: 'polyocr-export.zip' };
}

/**
 * Re-encode an `ImageData` to a PNG or WebP buffer for inclusion in the
 * archive. Cross-runtime: OffscreenCanvas in browsers, @napi-rs/canvas in
 * Node.
 */
async function encodeImage(image: ImageData, format: 'png' | 'webp'): Promise<Uint8Array> {
  if (typeof OffscreenCanvas !== 'undefined' && typeof Blob !== 'undefined') {
    const c = new OffscreenCanvas(image.width, image.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.putImageData(image, 0, 0);
    const blob = await c.convertToBlob({
      type: format === 'webp' ? 'image/webp' : 'image/png',
      ...(format === 'webp' ? { quality: 0.92 } : {})
    });
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }
  const canvasMod = await import('@napi-rs/canvas');
  const c = canvasMod.createCanvas(image.width, image.height);
  const ctx = c.getContext('2d');
  const napi = ctx.createImageData(image.width, image.height);
  napi.data.set(image.data);
  ctx.putImageData(napi, 0, 0);
  // @napi-rs/canvas's encode() typings accept different literal sets per
  // overload — splitting the call by format avoids a union-type mismatch.
  const buf = format === 'webp' ? await c.encode('webp', 92) : await c.encode('png');
  return new Uint8Array(buf);
}

/**
 * Replace `inpaintedImage` (huge typed array) with a metadata stub so JSON
 * exports don't blow up. The actual images are written separately under
 * `images/` when `include` contains 'images'.
 */
function stripBinary(results: ProcessResult[]): unknown[] {
  return results.map((r) => ({
    ...r,
    inpaintedImage: r.inpaintedImage
      ? { width: r.inpaintedImage.width, height: r.inpaintedImage.height, _strippedFromJson: true }
      : null
  }));
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}
