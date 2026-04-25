/**
 * OpenCV.js-based region detector.
 *
 * Pipeline:
 *   1. Convert the image to grayscale (`cv.cvtColor`, `COLOR_RGBA2GRAY`).
 *   2. Adaptive threshold (`cv.adaptiveThreshold`, Gaussian) — better than a
 *      global threshold for images with uneven lighting (e.g. a page with one
 *      side darker than the other under a desk lamp).
 *   3. Find contours (`cv.findContours`, `RETR_EXTERNAL`, `CHAIN_APPROX_SIMPLE`).
 *   4. Filter contours by:
 *      - closed boundary (a contour with the same start and end point)
 *      - area ≥ 500px² (excludes noise / single-character contours)
 *      - aspect ratio in [0.3, 3.0] (excludes very thin or very wide artifacts;
 *        speech bubbles and most text regions fall comfortably in this range)
 *      - convexity ratio ≥ 0.85 (the contour fills most of its convex hull —
 *        excludes ragged shapes; speech bubbles are nearly convex)
 *   5. Return the bounding rectangle of each surviving contour.
 *
 * `findSimilar()` is NOT implemented here — contour matching is too brittle for
 * the drift-tolerance use case. The LLM detector handles it. We return `null`
 * with a debug log if `findSimilar` is called on this adapter.
 *
 * Phase 2 implements this in full.
 */
export {};
