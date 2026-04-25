/**
 * SRT subtitle exporter.
 *
 * SRT format:
 *
 *   1
 *   00:00:01,000 --> 00:00:02,000
 *   Hello world
 *
 *   2
 *   00:00:02,000 --> 00:00:03,000
 *   Second subtitle
 *
 * Each `ProcessResult` becomes one block:
 *   - Block index = `result.index + 1` (SRT is 1-indexed).
 *   - Start time = `result.index / fps` seconds.
 *   - End time = `(result.index + 1) / fps` seconds (one frame's duration).
 *   - Text = `result.translation` if present, else `result.text`.
 *
 * If `fps` isn't supplied, the exporter falls back to `1` (one second per frame —
 * useful for image batches that aren't actually video).
 *
 * Timestamp format: `HH:MM:SS,mmm` — note the *comma* before milliseconds (this
 * is what distinguishes SRT from WebVTT, which uses a period).
 *
 * Phase 4 implements this in full.
 */
export {};
