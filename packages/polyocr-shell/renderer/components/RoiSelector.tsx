/**
 * ROI (region of interest) selector component.
 *
 * Renders an image inside a canvas overlay and lets the user click-drag
 * rectangles onto it. Each rectangle gets:
 *   - a free-form text label (defaults to "Region 1", "Region 2", ...)
 *   - a type toggle: "include" (OCR only here) or "exclude" (OCR everywhere
 *     except here)
 *
 * Output (via `onChange` prop):
 *   - `BoundingBox[]` for include zones
 *   - `BoundingBox[]` for exclude zones
 *   - Optionally `RegionReference[]` if the user marked a zone for cross-image
 *     matching (the component calls `window.polyocr.buildReference` for those).
 *
 * Coordinate translation:
 *   The canvas may be CSS-scaled (the image is 4000px wide but rendered at 800px
 *   on screen). The component must translate mouse coordinates from CSS pixels
 *   to image-pixel coordinates so the resulting `BoundingBox` is correct relative
 *   to the underlying image. The translation is:
 *
 *     const rect = canvas.getBoundingClientRect();
 *     const scaleX = canvas.width / rect.width;   // backing-store pixels per CSS pixel
 *     const scaleY = canvas.height / rect.height;
 *     const imgX = (mouseEvent.clientX - rect.left) * scaleX;
 *     const imgY = (mouseEvent.clientY - rect.top)  * scaleY;
 *
 *   We also account for `devicePixelRatio` if the canvas's backing-store has
 *   been multiplied for HiDPI displays — `canvas.width` already reflects the
 *   multiplied size, so the formula above is correct without further adjustment.
 *
 * Phase 5 implements this in full.
 */
export {};
