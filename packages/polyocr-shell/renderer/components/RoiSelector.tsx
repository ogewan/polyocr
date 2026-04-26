/**
 * ROI (region of interest) selector component.
 *
 * # M3 implementation note
 *   This is the M3 version — basic click-drag rectangle creation and
 *   include/exclude toggling. M4 adds: free-form labels, label rename,
 *   `RegionReference` building (calls `window.polyocr.buildReference`
 *   for zones the user wants matched in other images), DPR-aware
 *   coordinate translation polish, and rectangle resize handles.
 */

import { useEffect, useRef, useState } from 'react';
import type { BoundingBox } from 'polyocr';

interface RoiRect extends BoundingBox {
  id: string;
  label: string;
  type: 'include' | 'exclude';
}

export interface RoiSelectorProps {
  /** The image to draw rectangles on. */
  source: ImageData | null;
  /** Called whenever the rectangle list changes. */
  onChange: (regions: { include: BoundingBox[]; exclude: BoundingBox[] }) => void;
}

export function RoiSelector({ source, onChange }: RoiSelectorProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rects, setRects] = useState<RoiRect[]>([]);
  const [drag, setDrag] = useState<{ startX: number; startY: number; cur: BoundingBox } | null>(
    null
  );

  useEffect(() => {
    if (!source || !canvasRef.current) return;
    const c = canvasRef.current;
    c.width = source.width;
    c.height = source.height;
    redraw(c, source, rects, drag?.cur ?? null);
  }, [source, rects, drag]);

  useEffect(() => {
    onChange({
      include: rects.filter((r) => r.type === 'include').map(boxOf),
      exclude: rects.filter((r) => r.type === 'exclude').map(boxOf)
    });
  }, [rects, onChange]);

  const cssToImageCoords = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    // Translate from CSS-pixel mouse coords to image-pixel coords.
    // canvas.width is the backing-store size (already accounting for any
    // devicePixelRatio scaling we'd apply for HiDPI); rect.width is the
    // CSS-displayed size. The ratio between them is how many image
    // pixels each CSS pixel covers.
    const scaleX = c.width / rect.width;
    const scaleY = c.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = cssToImageCoords(e);
    setDrag({ startX: x, startY: y, cur: { x, y, w: 0, h: 0 } });
  };
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const { x, y } = cssToImageCoords(e);
    setDrag({
      ...drag,
      cur: {
        x: Math.min(drag.startX, x),
        y: Math.min(drag.startY, y),
        w: Math.abs(x - drag.startX),
        h: Math.abs(y - drag.startY)
      }
    });
  };
  const onMouseUp = () => {
    if (!drag) return;
    if (drag.cur.w > 5 && drag.cur.h > 5) {
      setRects((cur) => [
        ...cur,
        {
          ...drag.cur,
          id: crypto.randomUUID(),
          label: `Region ${cur.length + 1}`,
          type: 'include'
        }
      ]);
    }
    setDrag(null);
  };

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        className="max-w-full border border-slate-200 rounded cursor-crosshair"
      />
      {rects.length > 0 && (
        <ul className="text-xs space-y-1">
          {rects.map((r) => (
            <li key={r.id} className="flex items-center gap-2 bg-white border border-slate-200 rounded px-2 py-1">
              <span className="font-mono">{r.label}</span>
              <span className="text-slate-400">
                {Math.round(r.w)}×{Math.round(r.h)}
              </span>
              <select
                value={r.type}
                onChange={(e) =>
                  setRects((cur) =>
                    cur.map((x) => (x.id === r.id ? { ...x, type: e.target.value as RoiRect['type'] } : x))
                  )
                }
                className="ml-auto border rounded px-1 py-0.5 text-xs"
              >
                <option value="include">include</option>
                <option value="exclude">exclude</option>
              </select>
              <button
                onClick={() => setRects((cur) => cur.filter((x) => x.id !== r.id))}
                className="text-rose-600 hover:underline"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function boxOf(r: RoiRect): BoundingBox {
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

function redraw(
  canvas: HTMLCanvasElement,
  source: ImageData,
  rects: RoiRect[],
  preview: BoundingBox | null
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.putImageData(source, 0, 0);
  for (const r of rects) {
    ctx.strokeStyle = r.type === 'include' ? '#10b981' : '#ef4444';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = r.type === 'include' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  if (preview && preview.w > 0 && preview.h > 0) {
    ctx.strokeStyle = '#3b82f6';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(preview.x, preview.y, preview.w, preview.h);
    ctx.setLineDash([]);
  }
}
