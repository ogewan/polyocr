/**
 * Cross-process serialization helpers for `ProcessResult`.
 *
 * Electron's IPC uses the structured clone algorithm under the hood,
 * which can transfer `Uint8ClampedArray` and plain objects natively.
 * What it CAN'T preserve is the runtime identity of `ImageData` — the
 * receiving side gets a plain `{ data, width, height }` object, missing
 * the `colorSpace` field and the prototype methods. Renderer-side code
 * that reaches for `ctx.putImageData(result.inpaintedImage, ...)` will
 * fail with `TypeError: parameter 1 is not of type 'ImageData'` because
 * the constructor check is strict.
 *
 * The fix is to flatten `ImageData` to a plain serializable shape before
 * sending, then either reconstruct it via `new ImageData(...)` on the
 * renderer side (where the global exists) or hand it to the canvas
 * helper that the consuming code already uses.
 *
 * # When the renderer doesn't have `ImageData`
 *   Browsers / Electron renderers DO have `ImageData` — it's the main
 *   process that doesn't. So `serializeResult` is for main → renderer,
 *   and `deserializeResult` runs in the renderer.
 *
 *   For the reverse direction (renderer → main, e.g. RoiSelector
 *   exporting cropped pixels for `buildReference`), the same flat shape
 *   works: main passes the plain object straight to `pocr.normalize()`
 *   which already accepts `ArrayBuffer` and other input types.
 */

import type { ProcessResult, RecognizedRegion } from 'polyocr';
import type { SerializedProcessResult, SerializedImageData } from './shared/types.js';

/**
 * Convert a `ProcessResult` produced in main into the wire-format shape
 * suitable for `event.sender.send(...)` or an IPC reply. The only
 * non-trivial transformation is `inpaintedImage`.
 */
export function serializeResult(result: ProcessResult): SerializedProcessResult {
  return {
    index: result.index,
    text: result.text,
    language: result.language,
    languageConfidence: result.languageConfidence,
    regions: result.regions.map(serializeRegion),
    translation: result.translation,
    translationError: result.translationError,
    inpaintedImage: result.inpaintedImage
      ? serializeImageData(result.inpaintedImage)
      : null,
    cached: result.cached,
    durationMs: result.durationMs
  };
}

/**
 * Reconstruct a renderer-side `ProcessResult`. `ImageData` is rebuilt
 * via `new ImageData(data, width, height)` so it can be fed straight to
 * `ctx.putImageData(...)` without the prototype-mismatch error.
 *
 * Note: we return a `ProcessResult`-shaped object but typed loosely
 * because the renderer doesn't import the strict polyocr `ProcessResult`
 * (which depends on Node-only types in some transitive paths). The
 * shape is identical.
 */
export function deserializeResult(s: SerializedProcessResult): ProcessResultLike {
  return {
    index: s.index,
    text: s.text,
    language: s.language,
    languageConfidence: s.languageConfidence,
    regions: s.regions.map((r) => ({
      text: r.text,
      bbox: r.bbox,
      confidence: r.confidence,
      script: r.script
    })),
    translation: s.translation,
    translationError: s.translationError,
    // The ImageData constructor's typed signature insists on
    // Uint8ClampedArray<ArrayBuffer> (specifically not SharedArrayBuffer).
    // Structured-clone delivers a plain Uint8ClampedArray that doesn't
    // narrow that way at the type level even though it is one at runtime.
    // Cast through `as Uint8ClampedArray<ArrayBuffer>` to satisfy the
    // overload without copying the buffer.
    inpaintedImage: s.inpaintedImage
      ? new ImageData(
          s.inpaintedImage.data as Uint8ClampedArray<ArrayBuffer>,
          s.inpaintedImage.width,
          s.inpaintedImage.height
        )
      : null,
    cached: s.cached,
    durationMs: s.durationMs
  };
}

/**
 * Renderer-side mirror of polyocr's `ProcessResult`. Avoids importing
 * the package directly into the renderer (which would pull in
 * `tesseract.js` etc. that don't belong on the UI side).
 */
export interface ProcessResultLike {
  index: number;
  text: string;
  language: string | null;
  languageConfidence: number;
  regions: Array<{
    text: string;
    bbox: { x: number; y: number; w: number; h: number };
    confidence: number;
    script?: string;
  }>;
  translation: string | null;
  translationError: string | null;
  inpaintedImage: ImageData | null;
  cached: boolean;
  durationMs: number;
}

function serializeRegion(r: RecognizedRegion) {
  // `script` is optional in the source type — preserve undefined when
  // missing rather than emitting `script: undefined` (which structured
  // clone passes as `undefined` anyway, but explicit branching keeps
  // the wire format predictable).
  const out: SerializedProcessResult['regions'][number] = {
    text: r.text,
    bbox: r.bbox,
    confidence: r.confidence
  };
  if (r.script !== undefined) out.script = r.script;
  return out;
}

function serializeImageData(image: ImageData): SerializedImageData {
  // Important: use the exact backing buffer, not a copy. structured
  // clone will copy it on transfer; copying twice is wasteful for a
  // multi-megabyte image.
  return {
    data: image.data,
    width: image.width,
    height: image.height
  };
}
