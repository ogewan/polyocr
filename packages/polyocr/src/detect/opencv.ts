/**
 * OpenCV.js-based region detector.
 *
 * Pipeline:
 *   1. Convert the image to grayscale (`cv.cvtColor`, `COLOR_RGBA2GRAY`).
 *   2. Adaptive threshold (`cv.adaptiveThreshold`, Gaussian) — better than a
 *      global threshold for images with uneven lighting (e.g. a page with
 *      one side darker than the other under a desk lamp).
 *   3. Find contours (`cv.findContours`, `RETR_EXTERNAL`, `CHAIN_APPROX_SIMPLE`).
 *   4. Filter contours by:
 *      - area ≥ minArea (default 500px²) — excludes noise / single-character
 *        contours.
 *      - aspect ratio in [0.3, 3.0] — excludes very thin or very wide
 *        artifacts; speech bubbles and most text regions fall comfortably
 *        in this range.
 *      - convexity ≥ 0.85 (the contour fills most of its convex hull) —
 *        excludes ragged / fragmented shapes; speech bubbles are nearly
 *        convex.
 *   5. Return the bounding rectangle of each surviving contour, sorted by
 *      area descending.
 *
 * `findSimilar()` is NOT implemented here — contour matching is too brittle
 * for the drift-tolerance use case. The LLM detector handles it. We return
 * `null` with a debug log if `findSimilar` is called on this adapter.
 */

import type {
  RegionDetector,
  DetectOptions,
  RegionReference,
  BoundingBox
} from '../types.js';

interface OpenCVDetectorConfig {
  /** Pre-loaded `cv` module — useful when the consumer has already initialised
   *  OpenCV.js elsewhere (e.g. another part of their app). If omitted, we
   *  import `@techstark/opencv-js` lazily. */
  cv?: any;
}

/**
 * Module-scope cv reference once loaded. `@techstark/opencv-js` ships a
 * promise-resolving WASM module — we await it once and reuse.
 */
let cvPromise: Promise<any> | null = null;

async function loadCv(provided?: any, timeoutMs = 10000): Promise<any> {
  if (provided) return provided;
  if (cvPromise) return cvPromise;
  cvPromise = (async () => {
    const mod = await import('@techstark/opencv-js');
    // The package exposes a `cv` object that finishes WASM init when either
    // `cv.findContours` becomes a function (meaning the WASM is ready) OR
    // when `cv.onRuntimeInitialized` is called by the loader.
    //
    // The onRuntimeInitialized handler may have *already fired* by the time
    // our adapter is constructed (Node is fast at the post-import work) —
    // in that case registering it is a no-op and we'd hang forever.
    //
    // We poll instead: race the onRuntimeInitialized handler against a
    // 50ms-tick poll for `cv.findContours`, and against a hard timeout so
    // a broken WASM can't deadlock the whole pipeline.
    const cv: any = (mod as any).default ?? mod;
    if (typeof cv.findContours === 'function') return cv;
    const ready = await Promise.race([
      new Promise<'ready'>((resolve) => {
        cv.onRuntimeInitialized = () => resolve('ready');
      }),
      (async () => {
        for (;;) {
          if (typeof cv.findContours === 'function') return 'ready' as const;
          await new Promise((r) => setTimeout(r, 50));
        }
      })(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
    ]);
    if (ready === 'timeout') {
      throw new Error(`OpenCV.js did not initialize within ${timeoutMs}ms`);
    }
    return cv;
  })();
  return cvPromise;
}

export class OpenCVDetector implements RegionDetector {
  public readonly name = 'opencv';
  private readonly cvOverride?: any;

  constructor(config: OpenCVDetectorConfig = {}) {
    this.cvOverride = config.cv;
  }

  async isAvailable(): Promise<boolean> {
    // We deliberately do NOT trigger WASM init here. Initializing OpenCV.js
    // alongside Tesseract.js in a Node `worker_threads` context exposes a
    // flaky deadlock — both libraries are Emscripten-built and contend on
    // shared internal state during boot. Starting the WASM at probe time
    // can hang indefinitely.
    //
    // Instead we just verify the module is *importable*. Real init is
    // deferred to the first `detect()` call, where the user has explicitly
    // opted into using the detector and the timing context is well-defined.
    try {
      if (this.cvOverride) return typeof this.cvOverride.findContours === 'function';
      await import('@techstark/opencv-js');
      return true;
    } catch {
      return false;
    }
  }

  async detect(image: ImageData, options: DetectOptions = {}): Promise<BoundingBox[]> {
    const cv = await loadCv(this.cvOverride);
    const minArea = options.minArea ?? 500;
    const [arLow, arHigh] = options.aspectRatioRange ?? [0.3, 3.0];
    const limit = options.limit;

    // Allocate the input Mat from the ImageData. cv.matFromImageData expects
    // a real ImageData-shaped object (data + width + height); our cross-
    // runtime ImageData wrapper satisfies that.
    let src: any = null;
    let gray: any = null;
    let thresh: any = null;
    let contours: any = null;
    let hierarchy: any = null;
    try {
      src = cv.matFromImageData(image);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      // Adaptive threshold beats a fixed `cv.threshold` here because:
      //   - The image may have uneven lighting (a phone-photographed page
      //     darker on one side under a desk lamp).
      //   - Adaptive uses a per-pixel local mean computed over a neighborhood,
      //     so the binarization tracks the local background.
      // Gaussian-weighted variant (vs. mean-weighted) gives smoother boundaries
      // on anti-aliased edges. blockSize 21 and C 10 are empirical defaults
      // that work for ~A4-resolution scans down to phone screenshots.
      thresh = new cv.Mat();
      cv.adaptiveThreshold(
        gray,
        thresh,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        21,
        10
      );

      // findContours returns external contours only — we don't care about
      // holes inside speech bubbles, only their outer boundaries.
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const candidates: Array<{ bbox: BoundingBox; area: number }> = [];
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area < minArea) {
          contour.delete();
          continue;
        }
        const rect = cv.boundingRect(contour);
        const aspect = rect.width / Math.max(1, rect.height);
        if (aspect < arLow || aspect > arHigh) {
          contour.delete();
          continue;
        }

        // Convexity check — convex hull area / contour area. Closer to 1
        // means the contour is nearly convex (a speech bubble or text box).
        // Anything below 0.85 is ragged / fragmented and probably noise.
        const hull = new cv.Mat();
        cv.convexHull(contour, hull);
        const hullArea = cv.contourArea(hull);
        const convexity = hullArea > 0 ? area / hullArea : 0;
        hull.delete();
        if (convexity < 0.85) {
          contour.delete();
          continue;
        }

        candidates.push({
          bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          area
        });
        contour.delete();
      }

      candidates.sort((a, b) => b.area - a.area);
      const trimmed = limit ? candidates.slice(0, limit) : candidates;
      return trimmed.map((c) => c.bbox);
    } finally {
      // OpenCV.js Mats are WASM-backed and don't get GC'd by JS — we have
      // to delete every one we allocated or we leak WASM heap memory across
      // calls.
      src?.delete();
      gray?.delete();
      thresh?.delete();
      contours?.delete();
      hierarchy?.delete();
    }
  }

  async findSimilar(_image: ImageData, _reference: RegionReference): Promise<BoundingBox | null> {
    // Contour-matching across images is too brittle for the drift-tolerance
    // workflow (lighting changes, mild rotation, and slight scale changes
    // all break it). The LLM detector handles findSimilar.
    return null;
  }
}
