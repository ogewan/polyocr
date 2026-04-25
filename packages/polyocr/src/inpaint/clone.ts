/**
 * Content-aware (clone-stamp / Patch-Match) inpainting — STUB FOR v2.
 *
 * What "clone" mode would do conceptually: instead of filling the inpaint region
 * with a flat color (`fill` mode) or blur (`blur` mode), reconstruct the
 * background by *sampling patches from the rest of the image* that locally
 * match the missing region's surroundings, and stitching them together.
 *
 * Two well-known algorithms could implement this:
 *
 *   - **PatchMatch** (Barnes et al., 2009). For each pixel in the inpaint region,
 *     iteratively find the best-matching patch elsewhere in the image based on
 *     surrounding context. Start with random matches, propagate good matches to
 *     neighbors, refine via random search. Produces excellent results on natural
 *     textures (skin, foliage, cloth, brick walls). ~1 second per 100x100 region.
 *
 *   - **Frequency-domain inpainting** (FFT-based — Aujol et al., or NS / TV models
 *     of Bertalmio). Solve a PDE on the inpaint region's boundary conditions.
 *     Better for smooth-gradient regions (sky, gradients) than for textured ones.
 *
 * Why deferred to v2:
 *   - PatchMatch is non-trivial — a quality implementation is ~1500 lines and
 *     deserves a dedicated WASM module rather than being shipped as a JS port.
 *   - 95% of the use cases (manga bubbles, document backgrounds, labels) are
 *     covered by `fill` mode. The cases where clone would visibly outperform
 *     fill are textured backgrounds — and those are also the cases where
 *     translation overlay is rarely the goal.
 *   - Adding it now would inflate the bundle size by ~200KB and slow CI for
 *     a feature that isn't on the critical path.
 *
 * The stub implementation logs a warning the first time it's called per
 * `PolyOCR` instance and returns the input image unchanged. The caller's
 * `result.inpaintedImage` will be set to the unchanged source — they can detect
 * this by comparing pixel buffers if needed.
 *
 * Phase 3 implements the warning + pass-through stub.
 */
export {};
