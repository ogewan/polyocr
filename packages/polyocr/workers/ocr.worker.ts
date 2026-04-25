/**
 * Tesseract OCR worker shim.
 *
 * Tesseract.js's `createWorker()` already produces a Web Worker (in browsers)
 * or a `worker_threads` worker (in Node 20+). We don't double-wrap that — the
 * `TesseractAdapter` (in `src/ocr/tesseract.ts`) talks to Tesseract's
 * scheduler directly and the scheduler manages a pool of N Tesseract workers
 * round-robin.
 *
 * This file exists for advanced users who want a uniform `postMessage`
 * interface they can run in a context they control — for instance, a
 * Service Worker that pre-warms a Tesseract worker, or a sandboxed iframe
 * that runs OCR on user-uploaded PDFs. It accepts:
 *
 *   incoming: { id, imageData, options }
 *   outgoing: { id, ok: true,  result: OcrResult }
 *           | { id, ok: false, error: { code, message } }
 *
 * The adapter does NOT use this shim — it talks to Tesseract directly for
 * lower latency.
 */

import type { OcrOptions, OcrResult } from '../src/types.js';

declare const self: WorkerGlobalScope & {
  postMessage: (msg: unknown) => void;
  addEventListener: (event: string, fn: (e: MessageEvent) => void) => void;
};

interface InMsg {
  id: string;
  imageData: ImageData;
  options: OcrOptions;
}

self.addEventListener('message', async (e: MessageEvent<InMsg>) => {
  const { id, imageData, options } = e.data;
  try {
    // Lazy import — this file is only used when a consumer opts in, so
    // pulling Tesseract at message-time keeps the bundle slim.
    const { recognizeOnce } = await import('../src/ocr/tesseract.js');
    const result: OcrResult = await recognizeOnce(imageData, options);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: {
        code: 'OCR_FAILED',
        message: err instanceof Error ? err.message : String(err)
      }
    });
  }
});
