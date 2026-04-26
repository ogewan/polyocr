/**
 * Side-by-side inpaint preview component.
 *
 * Renders two canvases — source on the left, processed view on the
 * right — with a tab strip to flip between three rendering modes
 * mirroring `pocr.renderToCanvas()`:
 *
 *   - `inpainted`   — paints `result.inpaintedImage`. Requires the
 *                     caller to have run `process()` with
 *                     `inpaint: ...` and `output: { image: true }`.
 *   - `overlay`     — paints the source image, then renders the
 *                     translated text at each region's bbox.x/y in
 *                     20px sans-serif (no fill, just text). Useful
 *                     for proofreading translation placement without
 *                     the inpaint fill obscuring context.
 *   - `bboxes-only` — paints the source image, then strokes each
 *                     region's bbox in red and labels it with the
 *                     per-region confidence percentage. Debug mode.
 *
 * The rendering is intentionally a near-mirror of polyocr's
 * `renderToCanvas` (in `packages/polyocr/src/PolyOCR.ts`). We don't
 * call that method here because invoking it would require the
 * renderer to import `polyocr` directly — pulling in
 * tesseract.js/opencv-js etc. that don't belong in the UI bundle.
 * The render logic is small enough to duplicate; if it ever drifts
 * from polyocr's version, the divergence will be visible side-by-side
 * in the source-vs-result panes.
 */

import { useEffect, useRef, useState } from 'react';
import type { ProcessResultLike } from '../../serialize.js';

export type InpaintRenderMode = 'inpainted' | 'overlay' | 'bboxes-only';

export interface InpaintCanvasProps {
  /** The original source image (for the left canvas). */
  source: ImageData | null;
  /** The processed result. `inpaintedImage` drives the right canvas. */
  result: ProcessResultLike | null;
  /** Initial mode. Default `'inpainted'`. */
  initialMode?: InpaintRenderMode;
}

const MODES: InpaintRenderMode[] = ['inpainted', 'overlay', 'bboxes-only'];

const MODE_LABELS: Record<InpaintRenderMode, string> = {
  inpainted: 'Inpainted',
  overlay: 'Overlay',
  'bboxes-only': 'BBoxes'
};

export function InpaintCanvas({
  source,
  result,
  initialMode = 'inpainted'
}: InpaintCanvasProps): JSX.Element {
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const resultRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<InpaintRenderMode>(initialMode);

  // Source canvas — straight putImageData. Re-renders only when the
  // source image identity changes (parent should pass a stable
  // reference).
  useEffect(() => {
    if (!source || !sourceRef.current) return;
    drawSource(sourceRef.current, source);
  }, [source]);

  // Result canvas — branches on mode. Re-renders when mode, source, or
  // result changes.
  useEffect(() => {
    const c = resultRef.current;
    if (!c) return;
    if (mode === 'inpainted') {
      drawInpainted(c, result);
    } else if (mode === 'overlay') {
      drawOverlay(c, source, result);
    } else if (mode === 'bboxes-only') {
      drawBboxes(c, source, result);
    }
  }, [mode, source, result]);

  // Disable modes that the current state can't render so the user
  // doesn't tab into a blank canvas.
  const modeAvailable = (m: InpaintRenderMode): boolean => {
    if (m === 'inpainted') return !!result?.inpaintedImage;
    if (m === 'overlay') return !!source && !!result;
    if (m === 'bboxes-only') return !!source && !!result;
    return false;
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 text-xs">
        {MODES.map((m) => {
          const enabled = modeAvailable(m);
          const active = mode === m;
          return (
            <button
              key={m}
              disabled={!enabled}
              onClick={() => setMode(m)}
              title={
                !enabled && m === 'inpainted'
                  ? 'Run process with inpaint mode and output.image: true to enable'
                  : undefined
              }
              className={`px-3 py-1 rounded border ${
                active
                  ? 'bg-brand-500 text-white border-brand-500'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              } ${!enabled ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {MODE_LABELS[m]}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            source
          </div>
          <canvas ref={sourceRef} className="max-w-full border border-slate-200 rounded" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            {MODE_LABELS[mode].toLowerCase()}
          </div>
          <canvas ref={resultRef} className="max-w-full border border-slate-200 rounded" />
        </div>
      </div>
    </div>
  );
}

// ── Render helpers ──────────────────────────────────────────────────────

function drawSource(canvas: HTMLCanvasElement, source: ImageData): void {
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext('2d')?.putImageData(source, 0, 0);
}

function drawInpainted(canvas: HTMLCanvasElement, result: ProcessResultLike | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!result?.inpaintedImage) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  canvas.width = result.inpaintedImage.width;
  canvas.height = result.inpaintedImage.height;
  ctx.putImageData(result.inpaintedImage, 0, 0);
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  source: ImageData | null,
  result: ProcessResultLike | null
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || !source || !result) return;
  canvas.width = source.width;
  canvas.height = source.height;
  ctx.putImageData(source, 0, 0);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.font = '20px sans-serif';
  ctx.textBaseline = 'top';
  // Mirror polyocr.renderToCanvas('overlay'): text source is the
  // translation when present, falling back to the recognized text.
  // Each line in the text is rendered at the matching region's bbox.
  const text = result.translation ?? result.text;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && i < result.regions.length; i++) {
    const bbox = result.regions[i].bbox;
    ctx.fillText(lines[i], bbox.x, bbox.y);
  }
  ctx.restore();
}

function drawBboxes(
  canvas: HTMLCanvasElement,
  source: ImageData | null,
  result: ProcessResultLike | null
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || !source || !result) return;
  canvas.width = source.width;
  canvas.height = source.height;
  ctx.putImageData(source, 0, 0);
  ctx.save();
  ctx.strokeStyle = '#FF0000';
  ctx.lineWidth = 2;
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#FF0000';
  ctx.textBaseline = 'bottom';
  for (const r of result.regions) {
    ctx.strokeRect(r.bbox.x, r.bbox.y, r.bbox.w, r.bbox.h);
    ctx.fillText(`${(r.confidence * 100).toFixed(0)}%`, r.bbox.x, r.bbox.y);
  }
  ctx.restore();
}
