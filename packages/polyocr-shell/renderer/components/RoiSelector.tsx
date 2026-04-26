/**
 * ROI (region of interest) selector component.
 *
 * Renders an image inside a canvas overlay and lets the user
 * click-drag rectangles onto it. Each rectangle has:
 *   - a free-form text label (defaults to "Region 1", "Region 2", …;
 *     click the label to rename inline)
 *   - a type toggle: include / exclude
 *   - a "Save as reference" button that calls
 *     `window.polyocr.buildReference(crop, label)` and emits the
 *     resulting `RegionReference` via `onChange.references`.
 *
 * Output (via `onChange` prop):
 *   - `BoundingBox[]` for include zones
 *   - `BoundingBox[]` for exclude zones
 *   - `RegionReference[]` for zones the user has saved as references
 *     for cross-image matching.
 *
 * # Coordinate translation
 *
 *   The canvas may be CSS-scaled and may have a `devicePixelRatio`
 *   backing-store ratio for sharper rendering on HiDPI displays. Mouse
 *   events arrive in *CSS pixels* (the browser unit) but the
 *   `BoundingBox` we emit must be in *image pixels* (the underlying
 *   ImageData coordinate space). The translation:
 *
 *     1. Get the CSS-pixel offset of the cursor relative to the canvas:
 *          rect = canvas.getBoundingClientRect();
 *          cssX = mouseEvent.clientX - rect.left;
 *          cssY = mouseEvent.clientY - rect.top;
 *
 *     2. Compute the ratio between the canvas's backing-store size
 *        (`canvas.width`/`canvas.height` in image pixels) and its
 *        CSS-displayed size (`rect.width`/`rect.height` in CSS pixels):
 *          scaleX = canvas.width / rect.width;
 *          scaleY = canvas.height / rect.height;
 *
 *     3. Multiply:
 *          imgX = cssX * scaleX;
 *          imgY = cssY * scaleY;
 *
 *   `devicePixelRatio` is already accounted for here — when we
 *   intentionally upsize the backing-store for HiDPI by setting
 *   `canvas.width = imageWidth * dpr`, `canvas.width` already reflects
 *   that, so step 2's scale factor is correct without a separate DPR
 *   term. (If the backing store were 1:1 with image pixels and we
 *   wanted to upsize CSS-only, the scale factor would still come out
 *   right by the same logic.)
 *
 *   We currently set `canvas.width = source.width` (no DPR upscaling)
 *   because OCR images are already large; CSS scales them down for
 *   display via `max-w-full`. Keeping the backing store at native
 *   image size means click coords are already in image-pixel units
 *   modulo the `scaleX`/`scaleY` multiply.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoundingBox, RegionReference } from 'polyocr';

interface RoiRect extends BoundingBox {
  id: string;
  label: string;
  type: 'include' | 'exclude';
  reference?: RegionReference;
}

export interface RoiOnChangePayload {
  include: BoundingBox[];
  exclude: BoundingBox[];
  references: RegionReference[];
}

export interface RoiSelectorProps {
  /** The image to draw rectangles on. */
  source: ImageData | null;
  /** Called whenever the rectangle list changes. */
  onChange: (payload: RoiOnChangePayload) => void;
}

export function RoiSelector({ source, onChange }: RoiSelectorProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rects, setRects] = useState<RoiRect[]>([]);
  const [drag, setDrag] = useState<{ startX: number; startY: number; cur: BoundingBox } | null>(
    null
  );
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!source || !canvasRef.current) return;
    const c = canvasRef.current;
    c.width = source.width;
    c.height = source.height;
    redraw(c, source, rects, drag?.cur ?? null);
  }, [source, rects, drag]);

  // Memoize the onChange notification so we only fire when something
  // actually changed (not on every drag update which is local-only).
  useEffect(() => {
    onChange({
      include: rects.filter((r) => r.type === 'include').map(boxOf),
      exclude: rects.filter((r) => r.type === 'exclude').map(boxOf),
      references: rects.flatMap((r) => (r.reference ? [r.reference] : []))
    });
  }, [rects, onChange]);

  const cssToImageCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const c = canvasRef.current!;
      const rect = c.getBoundingClientRect();
      // See the docstring above for the math. canvas.width is the
      // backing-store size; rect.width is CSS-displayed. Their ratio
      // is image-pixels-per-CSS-pixel.
      const scaleX = c.width / rect.width;
      const scaleY = c.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    },
    []
  );

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

  const onSaveReference = async (rect: RoiRect) => {
    if (!source) return;
    setSavingId(rect.id);
    try {
      const crop = cropImageData(source, rect);
      // Send the crop as a structured-clone-safe SerializedImageData
      // shape. Main reconstructs ImageData via @napi-rs/canvas during
      // buildReference internally.
      const ref = await window.polyocr.buildReference(
        {
          data: crop.data,
          width: crop.width,
          height: crop.height
          // colorSpace is implied by our serialize convention.
        } as unknown as ImageData,
        rect.label
      );
      setRects((cur) => cur.map((r) => (r.id === rect.id ? { ...r, reference: ref } : r)));
    } catch (cause) {
      console.warn('buildReference failed:', cause);
    } finally {
      setSavingId(null);
    }
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
          {rects.map((r) => {
            const editing = editingLabel === r.id;
            return (
              <li
                key={r.id}
                className="flex items-center gap-2 bg-white border border-slate-200 rounded px-2 py-1"
              >
                {editing ? (
                  <input
                    autoFocus
                    type="text"
                    defaultValue={r.label}
                    onBlur={(e) => {
                      const next = e.currentTarget.value.trim() || r.label;
                      setRects((cur) =>
                        cur.map((x) => (x.id === r.id ? { ...x, label: next } : x))
                      );
                      setEditingLabel(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                      else if (e.key === 'Escape') setEditingLabel(null);
                    }}
                    className="font-mono border border-slate-300 rounded px-1 py-0.5"
                  />
                ) : (
                  <button
                    onClick={() => setEditingLabel(r.id)}
                    className="font-mono hover:bg-slate-100 px-1 rounded"
                    title="Click to rename"
                  >
                    {r.label}
                  </button>
                )}
                <span className="text-slate-400">
                  {Math.round(r.w)}×{Math.round(r.h)}
                </span>
                <select
                  value={r.type}
                  onChange={(e) =>
                    setRects((cur) =>
                      cur.map((x) =>
                        x.id === r.id ? { ...x, type: e.target.value as RoiRect['type'] } : x
                      )
                    )
                  }
                  className="ml-auto border rounded px-1 py-0.5 text-xs"
                >
                  <option value="include">include</option>
                  <option value="exclude">exclude</option>
                </select>
                {r.reference ? (
                  <span
                    className="text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded text-[10px]"
                    title={r.reference.description}
                  >
                    saved as ref
                  </span>
                ) : (
                  <button
                    onClick={() => onSaveReference(r)}
                    disabled={savingId === r.id}
                    className="text-brand-600 hover:underline disabled:opacity-40"
                    title="Build a RegionReference for cross-image matching"
                  >
                    {savingId === r.id ? 'saving…' : 'save as ref'}
                  </button>
                )}
                <button
                  onClick={() => setRects((cur) => cur.filter((x) => x.id !== r.id))}
                  className="text-rose-600 hover:underline"
                >
                  remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function boxOf(r: RoiRect): BoundingBox {
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

/**
 * Pixel-copy a sub-rectangle out of an ImageData. Used by
 * `onSaveReference` to feed a region's pixels into
 * `buildReference`.
 *
 * Why we don't go through canvas.drawImage: we already have raw pixel
 * data; drawImage would round-trip through GPU compositing for no
 * gain. A loop over the source's `data` buffer copies exactly the
 * rectangle into a new typed array.
 */
function cropImageData(source: ImageData, box: BoundingBox): ImageData {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(source.width, Math.floor(box.x + box.w));
  const y1 = Math.min(source.height, Math.floor(box.y + box.h));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y0 + row) * source.width + x0) * 4;
    const dstStart = row * w * 4;
    out.set(source.data.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return new ImageData(out, w, h);
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
