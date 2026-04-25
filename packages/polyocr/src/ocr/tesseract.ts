/**
 * Default OCR adapter — `tesseract.js` 5.x.
 *
 * Architecture:
 *   - Spawns `workerCount` Tesseract.js workers at construction.
 *   - Each worker holds a Tesseract scheduler in memory (model loaded once).
 *   - `recognize()` round-robins requests across the worker pool.
 *   - HOCR output is parsed for per-region bounding boxes.
 *
 * `isAvailable()` always resolves true: the engine is bundled WASM with no
 * external runtime dependency. The probe still validates that the WASM module
 * loaded successfully (catches corrupted / missing assets in unusual deployments).
 *
 * Phase 1 implements this in full.
 */
export {};
