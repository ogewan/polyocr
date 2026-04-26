/**
 * Side-by-side inpaint preview component.
 *
 * # M3 implementation note
 *   This is the M3 version — wires the source + inpainted canvases and
 *   lets the user toggle render modes by tab. M4 adds the OffscreenCanvas
 *   transfer for the "overlay" / "bboxes-only" modes (which need
 *   `pocr.renderToCanvas()` with a ProcessResult to draw labels and
 *   bounding boxes), plus the DPR-aware scaling for sharp output on
 *   HiDPI displays.
 */

import { useEffect, useRef, useState } from 'react';
import type { ProcessResultLike } from '../../serialize.js';

export type InpaintRenderMode = 'inpainted' | 'overlay' | 'bboxes-only';

export interface InpaintCanvasProps {
  /** The original source image (for the left canvas). */
  source: ImageData | null;
  /** The processed result. `inpaintedImage` drives the right canvas. */
  result: ProcessResultLike | null;
}

export function InpaintCanvas({ source, result }: InpaintCanvasProps): JSX.Element {
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const resultRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<InpaintRenderMode>('inpainted');

  useEffect(() => {
    if (!source || !sourceRef.current) return;
    const c = sourceRef.current;
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d')?.putImageData(source, 0, 0);
  }, [source]);

  useEffect(() => {
    if (!resultRef.current) return;
    const c = resultRef.current;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    if (mode === 'inpainted' && result?.inpaintedImage) {
      c.width = result.inpaintedImage.width;
      c.height = result.inpaintedImage.height;
      ctx.putImageData(result.inpaintedImage, 0, 0);
      return;
    }
    if ((mode === 'overlay' || mode === 'bboxes-only') && source && result) {
      // M4 will swap this for a real renderToCanvas call. M3 just shows
      // the source image with bbox outlines so the page is functional.
      c.width = source.width;
      c.height = source.height;
      ctx.putImageData(source, 0, 0);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      for (const r of result.regions) {
        ctx.strokeRect(r.bbox.x, r.bbox.y, r.bbox.w, r.bbox.h);
      }
      if (mode === 'overlay' && result.translation) {
        ctx.fillStyle = '#000';
        ctx.font = '20px sans-serif';
        ctx.textBaseline = 'top';
        const lines = result.translation.split(/\r?\n/);
        for (let i = 0; i < lines.length && i < result.regions.length; i++) {
          ctx.fillText(lines[i], result.regions[i].bbox.x, result.regions[i].bbox.y);
        }
      }
    }
  }, [mode, source, result]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2 text-xs">
        {(['inpainted', 'overlay', 'bboxes-only'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1 rounded border ${
              mode === m
                ? 'bg-brand-500 text-white border-brand-500'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">source</div>
          <canvas ref={sourceRef} className="max-w-full border border-slate-200 rounded" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{mode}</div>
          <canvas ref={resultRef} className="max-w-full border border-slate-200 rounded" />
        </div>
      </div>
    </div>
  );
}
