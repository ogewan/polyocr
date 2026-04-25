/**
 * Gaussian-blur inpainting.
 *
 * Apply a Gaussian blur (default σ=8) to the pixels within each OCR bbox.
 * Pure obfuscation — no text rendering. The use case is privacy redaction
 * (phone numbers, addresses, license plates) rather than translation
 * overlay.
 *
 * Why Gaussian:
 *   - Standard "soft" obfuscation. A box-blur is harsher and shows telltale
 *     square edges. A median filter preserves edges (bad — we want them
 *     gone). Gaussian is the right shape for "make this unreadable."
 *   - The kernel is separable (1D pass horizontal, then 1D pass vertical),
 *     so the cost is O(N · σ) per axis — roughly linear in σ even for very
 *     large kernels.
 *   - σ=8 obscures text below ~12px font size. Smaller σ leaves text
 *     reconstructible by deconvolution; much larger σ wastes compute.
 *
 * Implementation: a manual two-pass separable 1D Gaussian over typed
 * arrays. We don't pull in OpenCV.js for this because:
 *   - The dependency would be loaded just for `blur` mode users who don't
 *     run autoDetect.
 *   - A two-pass 1D Gaussian in plain JS over Uint8ClampedArray is fast
 *     enough (~5ms per 100×100 region on a typical laptop).
 */

import type { BoundingBox } from '../types.js';

export interface BlurOptions {
  /** Standard deviation in pixels. Default 8. */
  sigma?: number;
}

export function applyBlur(image: ImageData, regions: BoundingBox[], options: BlurOptions = {}): ImageData {
  const sigma = options.sigma ?? 8;
  const kernel = gaussianKernel1D(sigma);
  const radius = (kernel.length - 1) / 2;

  // Operate on a clone so the caller's input ImageData isn't mutated.
  const out = new Uint8ClampedArray(image.data);
  const w = image.width;
  const h = image.height;

  for (const bbox of regions) {
    // Expand the bbox by `radius` so the blur kernel has source pixels
    // outside the recognized text area to sample from. Without this, the
    // blur picks up zeros from the perimeter and creates a dark halo.
    const x0 = Math.max(0, Math.floor(bbox.x) - radius);
    const y0 = Math.max(0, Math.floor(bbox.y) - radius);
    const x1 = Math.min(w, Math.ceil(bbox.x + bbox.w) + radius);
    const y1 = Math.min(h, Math.ceil(bbox.y + bbox.h) + radius);
    blurRegion(out, w, h, x0, y0, x1, y1, kernel, radius);
  }

  return {
    data: out,
    width: w,
    height: h,
    colorSpace: (image as any).colorSpace ?? 'srgb'
  } as ImageData;
}

function blurRegion(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  kernel: Float32Array,
  radius: number
): void {
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;

  // Working buffer: pull the bbox region out, two passes (H then V),
  // write back.
  const region = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    const srcOff = ((y0 + y) * w + x0) * 4;
    region.set(data.subarray(srcOff, srcOff + rw * 4), y * rw * 4);
  }

  const tmp = new Float32Array(rw * rh * 4);
  // Horizontal pass
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        const xs = clamp(x + k, 0, rw - 1);
        const off = (y * rw + xs) * 4;
        const wt = kernel[k + radius];
        r += region[off] * wt;
        g += region[off + 1] * wt;
        b += region[off + 2] * wt;
        a += region[off + 3] * wt;
      }
      const dst = (y * rw + x) * 4;
      tmp[dst] = r;
      tmp[dst + 1] = g;
      tmp[dst + 2] = b;
      tmp[dst + 3] = a;
    }
  }
  // Vertical pass
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        const ys = clamp(y + k, 0, rh - 1);
        const off = (ys * rw + x) * 4;
        const wt = kernel[k + radius];
        r += tmp[off] * wt;
        g += tmp[off + 1] * wt;
        b += tmp[off + 2] * wt;
        a += tmp[off + 3] * wt;
      }
      const dst = ((y0 + y) * w + (x0 + x)) * 4;
      data[dst] = r;
      data[dst + 1] = g;
      data[dst + 2] = b;
      data[dst + 3] = a;
    }
  }
}

/**
 * Build a normalized 1D Gaussian kernel. The radius is `ceil(3*sigma)` so
 * we truncate beyond 3σ where the contribution is < 1% — standard practice
 * for finite-kernel Gaussian blur.
 */
function gaussianKernel1D(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  const denom = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / denom);
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  return kernel;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
