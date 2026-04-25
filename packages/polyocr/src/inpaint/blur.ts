/**
 * Gaussian-blur inpainting.
 *
 * For each OCR bbox, apply a Gaussian blur (default σ=8) to the pixels within
 * that region. Pure obfuscation — no text rendering. Useful when the goal is
 * privacy (redact phone numbers, addresses) rather than translation overlay.
 *
 * Why Gaussian:
 *   - It's the standard "soft" obfuscation. A box-blur is harsher and shows
 *     telltale square edges.
 *   - The kernel is separable (1D pass horizontal then vertical) so it's fast
 *     even on large regions.
 *   - σ=8 obscures text below ~12px font size. Smaller σ leaves text reconstructible
 *     by deconvolution; much larger σ wastes compute.
 *
 * Implementation uses a manual two-pass separable 1D Gaussian — we don't pull in
 * OpenCV.js for this because:
 *   - The dependency would be loaded just for `blur` mode users who don't run
 *     `autoDetect`.
 *   - A two-pass 1D Gaussian in plain JS over typed arrays is fast enough
 *     (~5ms per 100x100 region on a typical laptop).
 *
 * Phase 3 implements this in full.
 */
export {};
