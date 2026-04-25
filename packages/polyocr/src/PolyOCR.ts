/**
 * The PolyOCR class — the main user-facing entry point.
 *
 * Owns the configured adapters (OCR, region detection, translation), the cache
 * provider, the worker pool, and the per-call pipeline orchestration. Implements:
 *
 *   - `process(input, options)`        — single-image pipeline
 *   - `processBatch(inputs, options)`  — Phase 2: parallel batch with index ordering
 *   - `stream(inputs, options)`        — Phase 2: AsyncIterable yielding results as ready
 *   - `export(results, options)`       — Phase 4: serialize to JSON / CSV / SRT / VTT / ZIP
 *   - `renderToCanvas(result, canvas)` — Phase 4: draw inpainted / overlay / bbox mode
 *   - `buildReference(crop, label)`    — Phase 2: produce a `RegionReference`
 *   - `findRegion(image, reference)`   — Phase 2: locate a reference in a new image
 *   - `dispose()`                      — release worker pool, kill subprocesses
 *
 * The constructor accepts a `PolyOCRConfig` and instantiates default adapters,
 * calling `isAvailable()` on each. Adapters that fail availability are still
 * registered but the pipeline routes around them (translation skipped, region
 * detection skipped, etc.) rather than throwing. Errors are surfaced on
 * `ProcessResult.translationError` and similar fields, never via thrown exceptions.
 *
 * Phase 1 implements `process()` end-to-end with Tesseract + franc + Ollama.
 * Phase 2 adds batch / stream and the region-matching API.
 * Phase 3 wires inpainting into the per-image pipeline.
 * Phase 4 implements `export()` and `renderToCanvas()`.
 */
export {};
