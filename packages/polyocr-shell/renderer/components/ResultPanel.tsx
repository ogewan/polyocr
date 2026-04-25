/**
 * Result display component.
 *
 * Given a `ProcessResult`, renders:
 *   - Detected language + confidence (color-coded: green ≥ 0.85, yellow 0.5–0.85, red < 0.5)
 *   - Original recognized text (collapsible if > 200 chars)
 *   - Translation (if present) with a "copy" button
 *   - Region count + click-to-show bbox list with per-region confidence
 *   - Wall-clock duration in ms
 *   - A small "cached" pill if `result.cached`
 *
 * Used by the Single, Batch, and MangaMode pages.
 *
 * Phase 5 implements this in full.
 */
export {};
