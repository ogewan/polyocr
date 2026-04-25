/**
 * Inpainting dispatcher. Routes by `InpaintMode` to the appropriate
 * sub-module:
 *
 *   - 'chroma' → ./inpaint/chroma.ts (caller-supplied chroma mask)
 *   - 'blur'   → ./inpaint/blur.ts   (Gaussian over OCR bboxes)
 *   - 'fill'   → ./inpaint/fill.ts   (median perimeter + text render)
 *   - 'clone'  → ./inpaint/clone.ts  (stub; warns + returns input)
 */

import type {
  InpaintMode,
  BoundingBox,
  MaskRegion,
  FontConfig
} from './types.js';
import { applyBlur } from './inpaint/blur.js';
import { applyFill } from './inpaint/fill.js';
import { applyChroma } from './inpaint/chroma.js';
import { applyClone } from './inpaint/clone.js';

export interface InpaintInput {
  mode: InpaintMode;
  image: ImageData;
  regions: BoundingBox[];
  /** Optional translations (1:1 with regions). Used by 'fill' and 'chroma'. */
  texts?: string[];
  /** For 'chroma' mode — the mask regions extracted via `extractChromaMask`. */
  masks?: MaskRegion[];
  /** Font config for text rendering. */
  font?: FontConfig;
  /** Sigma for blur mode. */
  blurSigma?: number;
}

export async function inpaint(input: InpaintInput): Promise<ImageData> {
  switch (input.mode) {
    case 'blur':
      return applyBlur(input.image, input.regions, { sigma: input.blurSigma });
    case 'fill':
      return await applyFill(input.image, input.regions, input.texts ?? [], { font: input.font });
    case 'chroma': {
      if (!input.masks || input.masks.length === 0) return input.image;
      return await applyChroma(input.image, input.masks, input.texts ?? [], { font: input.font });
    }
    case 'clone':
      return applyClone(input.image, input.regions);
    default: {
      const _exhaustive: never = input.mode;
      void _exhaustive;
      return input.image;
    }
  }
}
