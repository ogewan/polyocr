/**
 * Input normalization. Every public entry point that accepts an image runs the
 * input through `normalize()` first, which dispatches on the input's runtime type
 * and produces a uniform `ImageData` for the rest of the pipeline.
 *
 * Each input shape requires different handling:
 *   - `File`/`Blob`         → `createImageBitmap` → drawn onto OffscreenCanvas
 *   - `HTMLImageElement`    → drawn onto canvas using `naturalWidth/Height`
 *   - `HTMLCanvasElement`   → direct `getContext('2d').getImageData(0, 0, w, h)`
 *   - `OffscreenCanvas`     → direct
 *   - `ImageData`           → pass-through (the common case after the first ingest)
 *   - `ArrayBuffer`         → wrap in `Blob` then `createImageBitmap`
 *   - `string` (path)       → Node-only: `fs.readFile` → Buffer → Blob
 *   - `string` (data URL)   → `fetch(dataUrl)` → blob (works in Node 20+)
 *   - `string` (base64)     → atob/Buffer.from → Blob
 *
 * In Node, `OffscreenCanvas` is polyfilled via the optional `canvas` package. If
 * `canvas` isn't installed, ingest falls back to throwing `INVALID_INPUT` for
 * shapes that require canvas rasterization — the user can either install it or
 * pre-rasterize and pass `ImageData` directly.
 *
 * Phase 1 implements this in full. The signature is:
 *
 *   normalize(input: PolyOCRInput): Promise<ImageData>
 *   extractChromaMask(imageData: ImageData, key: string, tolerance: number): MaskRegion[]
 */
export {};
