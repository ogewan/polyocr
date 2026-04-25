/**
 * Median-perimeter fill inpainting.
 *
 * The "good default" inpaint mode for translation overlay. Works on any
 * background where the immediate surroundings of the text region share roughly
 * the same color (a manga panel speech bubble, a label on a photographed sign,
 * a caption block on a video frame).
 *
 * Pipeline per region:
 *   1. Sample the perimeter pixels of the bbox (1 px from each edge — a single
 *      ring of pixels surrounding the text).
 *   2. Compute the *median* RGB color of those pixels.
 *   3. Fill the entire bbox interior with that median color.
 *   4. Call `font.ts::renderTextIntoRegion()` to draw the translated text.
 *
 * Why MEDIAN (not mean) of perimeter pixels:
 *   - The perimeter often clips a few pixels of the original character glyph
 *     (text rarely sits perfectly inside a bbox with no overlap).
 *   - Mean would be pulled toward the dark glyph color and produce a noticeably
 *     darker fill than the surrounding background.
 *   - Median is robust to ~20% outlier pixels — comfortably ignores those clipped
 *     glyph fragments and returns the dominant background color.
 *
 * Why bbox interior (not the actual character mask):
 *   - We don't have a per-pixel character mask from Tesseract HOCR. Building
 *     one would require running Tesseract in a different mode and rebuilding
 *     the bitmap.
 *   - For typical bubble / label backgrounds where the perimeter color is
 *     uniform, the rectangular fill is visually indistinguishable from a
 *     mask-aware fill.
 *
 * Phase 3 implements this in full.
 */
export {};
