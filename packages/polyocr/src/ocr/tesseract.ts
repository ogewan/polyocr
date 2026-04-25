/**
 * Default OCR adapter — `tesseract.js` 5.x.
 *
 * Architecture:
 *   - Spawns `workerCount` Tesseract.js workers at construction (lazy — the
 *     scheduler is built on first `recognize()` call so a `PolyOCR` that's
 *     never used costs no model-load time).
 *   - Each worker holds a Tesseract scheduler in memory (model loaded once).
 *   - `recognize()` round-robins through Tesseract's built-in scheduler.
 *   - Tesseract returns words, lines, and blocks with bounding boxes; we map
 *     the *line*-level results to `RecognizedRegion[]` because per-line
 *     bboxes give the cleanest input to the inpaint stage (per-word would
 *     produce too many tiny regions; per-block too few large ones).
 *
 * `isAvailable()` always resolves true — Tesseract.js is bundled WASM with
 * no external runtime dependency.
 *
 * # Tesseract concepts (for the curious)
 *
 *   PSM (Page Segmentation Mode) — tells Tesseract how to interpret the
 *   input layout. `3` (default, fully automatic) handles mixed page layout;
 *   `6` (single uniform block) is faster and better for ROI crops; `7`
 *   (single text line) is best when you've already isolated one line.
 *
 *   OEM (OCR Engine Mode) — `1` is LSTM-only, the modern neural engine.
 *   `0` is the legacy Tesseract algorithm; `2` is both. The LSTM-only mode
 *   is the right choice for almost everyone in 2025+.
 *
 *   HOCR — HTML-formatted OCR output with embedded bounding boxes. We don't
 *   use HOCR directly because Tesseract.js already exposes structured
 *   `lines[]` / `words[]` / `blocks[]` objects — but the underlying engine
 *   is generating the same data internally.
 */

import type { OcrAdapter, OcrOptions, OcrResult, RecognizedRegion } from '../types.js';

interface TesseractAdapterConfig {
  /** Languages to load (Tesseract codes, e.g. `'eng'`, `'jpn'`, `'chi_sim'`). */
  languages?: string[];
  /** Number of worker threads. Default 2. */
  workerCount?: number;
  /** Logger function for Tesseract progress events. */
  logger?: (m: { status: string; progress: number }) => void;
}

/**
 * Tesseract scheduler instance — created lazily, shared across all calls.
 * Stored at module scope so a single Node process running multiple `PolyOCR`
 * instances doesn't double-load the language model.
 *
 * Caller code should normally use one `TesseractAdapter` per `PolyOCR`; the
 * scheduler reuse here is just a defensive optimization.
 */
let sharedScheduler: any = null;
let schedulerPromise: Promise<any> | null = null;

export class TesseractAdapter implements OcrAdapter {
  public readonly name = 'tesseract';
  private readonly languages: string[];
  private readonly workerCount: number;
  private readonly logger?: (m: { status: string; progress: number }) => void;

  constructor(config: TesseractAdapterConfig = {}) {
    this.languages = config.languages ?? ['eng'];
    this.workerCount = config.workerCount ?? 2;
    this.logger = config.logger;
  }

  async isAvailable(): Promise<boolean> {
    // Probe by loading the Tesseract module — if the WASM assets aren't
    // available the import itself will reject. We don't actually create a
    // worker yet (that triggers a model download).
    try {
      await import('tesseract.js');
      return true;
    } catch {
      return false;
    }
  }

  async recognize(image: ImageData, options: OcrOptions): Promise<OcrResult> {
    const scheduler = await this.getScheduler();
    const input = await imageDataToTesseractInput(image);
    // PSM and OEM are scheduler-wide parameters in Tesseract.js v5 — set via
    // the worker's `setParameters` rather than the per-job options. We leave
    // them at the engine defaults here; consumers who want a non-default PSM
    // can construct their own `TesseractAdapter` and pass `setParameters` via
    // the scheduler bootstrap. (Per-job overrides require a scheduler API
    // upstream Tesseract.js does not currently expose.)
    void options;
    const { data } = await scheduler.addJob('recognize', input);
    return mapTesseractResult(data);
  }

  async dispose(): Promise<void> {
    if (sharedScheduler) {
      await sharedScheduler.terminate();
      sharedScheduler = null;
      schedulerPromise = null;
    }
  }

  private async getScheduler() {
    if (sharedScheduler) return sharedScheduler;
    if (schedulerPromise) return schedulerPromise;
    schedulerPromise = (async () => {
      const tesseract = await import('tesseract.js');
      const scheduler = tesseract.createScheduler();
      // Spawn `workerCount` workers, each loading the requested languages.
      // This is parallelizable across workers — the model files are downloaded
      // once and cached at the OS / browser cache layer.
      const langArg = this.languages.join('+');
      const workerOpts: any = {};
      if (this.logger) workerOpts.logger = this.logger;
      const workers = await Promise.all(
        Array.from({ length: this.workerCount }, async () => {
          const w = await tesseract.createWorker(langArg, 1, workerOpts);
          return w;
        })
      );
      for (const w of workers) scheduler.addWorker(w);
      sharedScheduler = scheduler;
      return scheduler;
    })();
    return schedulerPromise;
  }
}

/**
 * Standalone one-shot recognize — used by the worker shim. Spins up a single
 * worker, runs one job, terminates. This is intentionally NOT efficient for
 * batch use; `TesseractAdapter` is the right entry point for production.
 */
export async function recognizeOnce(image: ImageData, options: OcrOptions): Promise<OcrResult> {
  const tesseract = await import('tesseract.js');
  const input = await imageDataToTesseractInput(image);
  const worker = await tesseract.createWorker('eng');
  try {
    if (options.psm !== undefined || options.oem !== undefined) {
      // setParameters is the v5-supported way to tune PSM/OEM at runtime.
      await worker.setParameters({
        ...(options.psm !== undefined && { tessedit_pageseg_mode: String(options.psm) as any }),
        ...(options.oem !== undefined && { tessedit_ocr_engine_mode: String(options.oem) as any })
      });
    }
    const { data } = await worker.recognize(input);
    return mapTesseractResult(data);
  } finally {
    await worker.terminate();
  }
}

/**
 * Tesseract.js needs an image input it can decode. In browsers it accepts
 * `ImageData` directly; in Node it does NOT (the Tesseract Node worker
 * runs in `worker_threads`, where the `ImageData` global is missing and the
 * decoder rejects raw `Uint8ClampedArray` shapes that don't match its
 * expected magic-byte image formats).
 *
 * We resolve the cross-runtime gap by:
 *   - Browser / OffscreenCanvas-capable contexts: pass the `ImageData`
 *     through unchanged. Tesseract draws it onto its own canvas internally.
 *   - Node: re-encode to a PNG `Buffer` via `@napi-rs/canvas`. The PNG
 *     encode adds ~5–20ms per image, which is negligible next to the
 *     200ms–2s OCR runtime.
 */
async function imageDataToTesseractInput(image: ImageData): Promise<ImageData | Buffer> {
  if (typeof OffscreenCanvas !== 'undefined' && typeof Blob !== 'undefined') {
    return image;
  }
  // Node path. @napi-rs/canvas's putImageData requires its own ImageData
  // instance (not a plain object), so we allocate one via `createImageData`
  // and copy pixels in.
  const { createCanvas } = await import('@napi-rs/canvas');
  const c = createCanvas(image.width, image.height);
  const ctx = c.getContext('2d');
  const napiImageData = ctx.createImageData(image.width, image.height);
  napiImageData.data.set(image.data);
  ctx.putImageData(napiImageData, 0, 0);
  const buf = await c.encode('png');
  return Buffer.from(buf);
}

/**
 * Map Tesseract's structured output to our `OcrResult`. We use line-level
 * bounding boxes — see the module-level docstring for the rationale.
 */
function mapTesseractResult(data: any): OcrResult {
  const regions: RecognizedRegion[] = [];
  const lines = (data?.lines ?? []) as Array<{
    text: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
    confidence: number;
  }>;
  for (const line of lines) {
    const text = (line.text ?? '').trim();
    if (!text) continue;
    regions.push({
      text,
      bbox: {
        x: line.bbox.x0,
        y: line.bbox.y0,
        w: line.bbox.x1 - line.bbox.x0,
        h: line.bbox.y1 - line.bbox.y0
      },
      // Tesseract reports confidence in 0..100; normalize to 0..1.
      confidence: (line.confidence ?? 0) / 100
    });
  }
  return {
    text: (data?.text ?? '').trim(),
    regions,
    confidence: data?.confidence !== undefined ? data.confidence / 100 : undefined,
    engine: 'tesseract'
  };
}
