/**
 * Inpainting dispatcher.
 *
 * Given an `InpaintMode`, routes to the appropriate sub-module:
 *
 *   - `'chroma'` → `./inpaint/chroma.ts`
 *   - `'blur'`   → `./inpaint/blur.ts`
 *   - `'fill'`   → `./inpaint/fill.ts`
 *   - `'clone'`  → `./inpaint/clone.ts` (stub — logs warning, returns input unchanged)
 *
 * The dispatcher's signature is uniform across modes:
 *
 *   inpaint(
 *     image: ImageData,
 *     regions: BoundingBox[],
 *     translations: string[],
 *     mode: InpaintMode,
 *     opts: InpaintOptions
 *   ): Promise<ImageData>
 *
 * `regions[i]` and `translations[i]` are 1:1 — each region gets its corresponding
 * translation rendered into it (when the mode renders text at all; `'blur'` ignores
 * `translations`).
 *
 * Phase 3 implements this file plus all four sub-modules.
 */
export {};
