/**
 * Text rendering for inpaint modes that draw translated text back into the image.
 *
 * Used by: `inpaint/chroma.ts` and `inpaint/fill.ts`.
 *
 * Public function:
 *
 *   renderTextIntoRegion(
 *     ctx: OffscreenCanvasRenderingContext2D,
 *     text: string,
 *     bbox: BoundingBox,
 *     config: FontConfig
 *   ): void
 *
 * Why this is more complex than `ctx.fillText(text, bbox.x, bbox.y)`:
 *
 * Canvas has no CSS layout. There's no `text-overflow`, no `word-wrap`, no
 * `flex` to stretch text to fit a region. The only primitives are
 * `ctx.measureText(s)` (returns metrics for a single rendered string at the
 * current font) and `ctx.fillText(s, x, y)`. So we have to do layout manually.
 *
 * Algorithm:
 *   1. Binary search the font size between `[minSize, maxSize]`. For each
 *      candidate size:
 *        - Set `ctx.font` to that size.
 *        - Word-wrap the text by greedily fitting words onto each line:
 *          measure each word + ' ', append to current line if it still fits
 *          within (bbox.w - 2*padding), else start a new line.
 *        - Compute total text height as `lines.length * lineHeight * fontSize`.
 *        - Acceptable iff total height ≤ (bbox.h - 2*padding) AND the longest
 *          line's measured width ≤ (bbox.w - 2*padding).
 *      Pick the largest size that's acceptable. Halt when the search interval
 *      collapses to ≤ 1px.
 *   2. Render the wrapped text centered vertically within the bbox.
 *
 * Why a binary search (not a linear walk):
 *   - The acceptable-size range can be 8–64 — 56 candidates per region.
 *   - A batch of 50 manga panels with 6 bubbles each = 300 regions × 56 calls =
 *     16,800 measurements per batch. Binary search drops that to ~6 per region,
 *     ~1,800 per batch.
 *   - `measureText` isn't free — it's the canvas drawing the text into a hidden
 *     context to get metrics. Avoiding 90% of the calls is worth the slightly
 *     more complex code.
 *
 * Font loading:
 *   - The package bundles a Noto Sans Latin + CJK subset as a base64 string.
 *   - On first use we register it via `FontFace` and `document.fonts.add` (in
 *     browsers) or via `registerFont` from the `canvas` package (in Node).
 *   - We load on first use rather than at import time so that callers who never
 *     run inpaint mode don't pay the load cost.
 *
 * Phase 3 implements this in full.
 */
export {};
