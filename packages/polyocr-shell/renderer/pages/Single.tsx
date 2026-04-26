/**
 * Single-image page — drag-drop or browse one image, choose target
 * language + inpaint mode, see result side-by-side.
 *
 * # Why we read drag-dropped files into ArrayBuffer instead of using
 *   File.path
 *   Recent Electron versions removed the `path` property from File for
 *   sandboxed renderers. Reading the file into an ArrayBuffer is a
 *   small cost (typically a few MB per image) and works uniformly for
 *   both drag-drop and clipboard paste.
 */

import { useEffect, useRef, useState } from 'react';
import type { ProcessResultLike } from '../../serialize.js';
import type { Settings } from '../../shared/types.js';
import type { InpaintMode } from 'polyocr';
import { ResultPanel } from '../components/ResultPanel.js';
import { InpaintCanvas } from '../components/InpaintCanvas.js';

interface SingleProps {
  settings: Settings;
}

export function Single({ settings }: SingleProps): JSX.Element {
  const [input, setInput] = useState<{
    /** ArrayBuffer for IPC + the decoded ImageData for canvas display. */
    buffer: ArrayBuffer;
    image: ImageData;
    name: string;
  } | null>(null);
  const [target, setTarget] = useState<string>(settings.defaultTargetLanguage ?? '');
  const [inpaint, setInpaint] = useState<InpaintMode | ''>(settings.defaultInpaintMode ?? '');
  const [result, setResult] = useState<ProcessResultLike | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);

  // Drag-drop wiring. preventDefault on dragover is required for the
  // drop event to fire — otherwise the browser navigates to the
  // dropped file.
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file) await loadFile(file);
    };
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, []);

  const loadFile = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const image = await decodeImageData(buffer);
    setInput({ buffer, image, name: file.name });
    setResult(null);
    setError(null);
  };

  const onBrowse = async () => {
    const picked = await window.shell.openFilePicker();
    if (!picked || !picked[0]) return;
    // Path-based loading: pass the path straight through to polyocr,
    // and decode locally for the source canvas.
    const path = picked[0];
    const blob = await fetch(`file://${path.replace(/\\/g, '/')}`).then((r) => r.blob());
    const buffer = await blob.arrayBuffer();
    const image = await decodeImageData(buffer);
    setInput({ buffer, image, name: path.split(/[\\/]/).pop() ?? path });
    setResult(null);
    setError(null);
  };

  const onProcess = async () => {
    if (!input) return;
    setRunning(true);
    setError(null);
    try {
      const r = await window.polyocr.process(input.buffer, {
        ...(target && { translate: target }),
        ...(inpaint && { inpaint: inpaint as InpaintMode }),
        output: { text: true, regions: true, image: !!inpaint }
      });
      // Reconstruct ImageData on the renderer side.
      setResult({
        ...r,
        inpaintedImage: r.inpaintedImage
          ? new ImageData(
              r.inpaintedImage.data as Uint8ClampedArray<ArrayBuffer>,
              r.inpaintedImage.width,
              r.inpaintedImage.height
            )
          : null
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 space-y-4">
      <h1 className="text-2xl font-semibold">Single image</h1>

      <div
        ref={dropRef}
        className="border-2 border-dashed border-slate-300 rounded p-8 text-center bg-white hover:border-brand-400 transition-colors"
      >
        {input ? (
          <div className="text-sm">
            <div className="font-mono text-slate-700">{input.name}</div>
            <div className="text-xs text-slate-500 mt-1">
              {input.image.width}×{input.image.height}px ·{' '}
              {(input.buffer.byteLength / 1024).toFixed(0)} KB
            </div>
          </div>
        ) : (
          <div className="text-slate-500 text-sm">Drag an image here or click Browse</div>
        )}
        <button
          onClick={onBrowse}
          className="mt-3 px-3 py-1 border border-slate-300 rounded hover:bg-slate-50 text-sm"
        >
          Browse…
        </button>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-sm space-y-1">
          <div className="text-xs text-slate-600">Target language</div>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="e.g. en (blank skips)"
            className="border border-slate-300 rounded px-2 py-1 w-40 font-mono"
          />
        </label>
        <label className="text-sm space-y-1">
          <div className="text-xs text-slate-600">Inpaint mode</div>
          <select
            value={inpaint}
            onChange={(e) => setInpaint(e.target.value as InpaintMode | '')}
            className="border border-slate-300 rounded px-2 py-1"
          >
            <option value="">none</option>
            <option value="fill">fill</option>
            <option value="blur">blur</option>
            <option value="chroma">chroma</option>
            <option value="clone">clone (stub)</option>
          </select>
        </label>
        <button
          onClick={onProcess}
          disabled={!input || running}
          className="px-4 py-1.5 bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-40"
        >
          {running ? 'Processing…' : 'Process'}
        </button>
      </div>

      {error && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ResultPanel result={result} loading={running} />
        {input && result && inpaint && (
          <InpaintCanvas source={input.image} result={result} />
        )}
      </div>
    </div>
  );
}

/**
 * Decode an ArrayBuffer (PNG/JPG/WEBP/etc.) into ImageData via the
 * browser's createImageBitmap → canvas pipeline. Renderer-side only —
 * main has its own decode path via @napi-rs/canvas.
 */
async function decodeImageData(buffer: ArrayBuffer): Promise<ImageData> {
  const blob = new Blob([buffer]);
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire 2D context for image decode');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}
