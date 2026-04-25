/**
 * Export dispatcher.
 *
 * Routes by `format`:
 *   - 'json' → JSON.stringify with inpaintedImage replaced by a metadata
 *              stub (the typed-array would explode the JSON otherwise).
 *   - 'txt'  → newline-joined text (translation > original).
 *   - 'csv'  → ./csv.ts
 *   - 'srt'  → ./srt.ts
 *   - 'vtt'  → ./vtt.ts
 *   - 'zip'  → ./zip.ts
 *
 * Returns a `Buffer` in Node (where `Buffer` is defined and `Blob` may
 * not be a primary type) and a `Blob` in browsers / Electron renderers.
 * The Node main process and browser/renderer paths produce equivalent
 * bytes; only the wrapper differs.
 */

import type { ProcessResult, ExportOptions } from '../types.js';
import { PolyOCRError } from '../types.js';
import { toCsv } from './csv.js';
import { toSrt } from './srt.js';
import { toVtt } from './vtt.js';
import { toZip } from './zip.js';

export async function exportResults(
  results: ProcessResult[],
  options: ExportOptions
): Promise<Buffer | Blob> {
  switch (options.format) {
    case 'json': {
      const stripped = results.map((r) => ({
        ...r,
        inpaintedImage: r.inpaintedImage
          ? { width: r.inpaintedImage.width, height: r.inpaintedImage.height, _strippedFromJson: true }
          : null
      }));
      return wrap(JSON.stringify(stripped, null, 2), 'application/json');
    }
    case 'txt': {
      const text = [...results]
        .sort((a, b) => a.index - b.index)
        .map((r) => (r.translation ?? r.text ?? '').trimEnd())
        .join('\n');
      return wrap(text, 'text/plain');
    }
    case 'csv':
      return wrap(toCsv(results, options), 'text/csv');
    case 'srt':
      return wrap(toSrt(results, options), 'application/x-subrip');
    case 'vtt':
      return wrap(toVtt(results, options), 'text/vtt');
    case 'zip': {
      const z = await toZip(results, options);
      return z.data;
    }
    default: {
      const _exhaustive: never = options.format;
      throw new PolyOCRError('EXPORT_FAILED', `Unknown export format: ${String(_exhaustive)}`);
    }
  }
}

function wrap(content: string, mime: string): Buffer | Blob {
  // Browser / renderer: prefer Blob.
  if (typeof Blob !== 'undefined' && typeof process === 'undefined') {
    return new Blob([content], { type: mime });
  }
  // Node: Buffer.
  return Buffer.from(content, 'utf8');
}
