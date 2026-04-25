/**
 * Export dispatcher.
 *
 * Routes by `format`:
 *   - `'json'` → JSON.stringify with inpaintedImage re-encoded as data URL
 *   - `'txt'`  → newline-joined text (translation > original)
 *   - `'csv'`  → `./csv.ts`
 *   - `'srt'`  → `./srt.ts`
 *   - `'vtt'`  → `./vtt.ts`
 *   - `'zip'`  → `./zip.ts`
 *
 * Returns `Buffer` in Node main process, `Blob` in browser/Electron renderer.
 * The dispatcher detects the runtime via `typeof Blob` and `typeof Buffer` and
 * coerces the underlying exporter's output as needed.
 *
 * Phase 4 implements this in full.
 */
export {};
