/**
 * Batch processing page.
 *
 * Layout:
 *   - Source picker: directory dialog OR drag-drop multiple files.
 *   - Options panel: target language, inpaint mode, export format,
 *     `autoDetect`, `detectWithLLM`, concurrency, optional `--ref` reference image.
 *   - Progress bar (driven by `polyocr:stream:result` events emitted from main).
 *   - Results table — one row per image, populated as the stream yields.
 *     Columns: thumbnail, filename, detected language, text snippet,
 *     translation snippet, duration, status.
 *   - Export button — calls `window.polyocr.export()` then `window.shell.saveFile()`.
 *
 * Streaming UX detail: results arrive out of order (by completion time) but
 * the table is sorted by `result.index` and rows fade in as they fill. A
 * "Cancel" button calls a `polyocr:cancel-stream` IPC that aborts in-flight
 * worker jobs.
 *
 * Phase 5 implements this in full.
 */
export {};
