/**
 * Tesseract OCR worker.
 *
 * Runs in:
 *   - A `Worker` (browser / Electron renderer)
 *   - A `Worker` from `node:worker_threads` (Node main process / Electron main)
 *
 * Why a worker:
 *   - Tesseract.recognize() blocks the calling thread for 200ms–2s depending on
 *     image complexity. In the renderer, that freezes the UI; in the Electron
 *     main process, that freezes IPC.
 *   - Workers also let us run multiple OCR jobs in parallel without contention,
 *     since each worker holds its own scheduler.
 *
 * Message protocol:
 *
 *   incoming: { id: string, imageData: ImageData, options: OcrOptions }
 *   outgoing: { id: string, ok: true,  result: OcrResult }
 *           | { id: string, ok: false, error: { code, message } }
 *
 * The worker manages its own Tesseract scheduler — it loads language models
 * lazily (first request that asks for `eng+jpn` triggers download/load) and
 * reuses them across requests.
 *
 * Phase 1 implements this in full.
 */
export {};
