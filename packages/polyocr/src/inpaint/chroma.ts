/**
 * Chroma-key inpainting.
 *
 * The caller pre-marks regions to inpaint by painting them a chroma color
 * (default `#FF00FF` — magenta is the conventional choice because it's almost
 * never present in natural images, so false-positive matches are rare).
 *
 * Pipeline:
 *   1. `extractChromaMask(image, key, tolerance)` (in `ingest.ts`) extracts the
 *      mask — a `MaskRegion[]` where each region is the bbox + a packed pixel
 *      mask of which pixels matched the chroma color within `tolerance`.
 *   2. For each masked region, sample non-masked perimeter pixels → median color
 *      → flood-fill the masked pixels with that color (NOT the bbox interior —
 *      we use the actual mask shape, which may be irregular).
 *   3. Render the translated text onto the bbox using `inpaint/font.ts`.
 *
 * Why chroma over auto-detect: when the user *knows* exactly what they want
 * inpainted (e.g. a designer marking specific text balloons in a manga page in
 * Photoshop before automation), painting a magenta mask is more reliable than
 * any detector. The OCR step is skipped for chroma-only mode — the caller
 * provides the translations directly via `translations[]`.
 *
 * Phase 3 implements this in full.
 */
export {};
