/**
 * Formal RegionDetector adapter interface.
 *
 * Two responsibilities, intentionally bundled in one interface because real-world
 * implementations almost always implement both:
 *
 *   - `detect(image)`: scan the whole image for candidate text regions. Used by
 *     the `autoDetect: true` option as a pre-pass to OCR. The OpenCV implementation
 *     uses contour analysis; the LLM implementation prompts a vision model for a
 *     JSON list of bboxes.
 *
 *   - `findSimilar(image, reference)`: locate a previously-described region in a
 *     new image. This powers the "instrument readout" workflow — the user builds
 *     one `RegionReference` from a representative frame, then for every subsequent
 *     frame the detector finds where the same region has drifted to.
 *
 * # When to implement this interface
 * Implement a custom detector when you need:
 *   - Domain-specific shape detection (e.g. license plates) the contour detector
 *     handles poorly.
 *   - A faster / cheaper template matcher than the vision LLM.
 *   - Integration with an existing object-detection pipeline (YOLO, Detectron, etc.).
 *
 * # What `isAvailable()` is expected to do
 *   - OpenCV-based detectors: check `cv` is loaded and exposes `findContours`.
 *   - LLM-based detectors: hit `GET {ollamaUrl}/api/tags` and confirm the configured
 *     vision model is in the response.
 *   - Custom HTTP detectors: ping the model server.
 *
 * # Error handling
 * Both methods are expected to fail-soft. `detect()` returns `[]` if it can't
 * extract anything; `findSimilar()` returns `null`. They should never throw —
 * the caller's pipeline must continue with whatever fallback is appropriate.
 */
export type {
  RegionDetector,
  DetectOptions,
  RegionReference,
  BoundingBox
} from '../types.js';
