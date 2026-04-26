/**
 * Manga mode page — sequential image panels with auto-detected speech
 * bubbles + per-panel inpaint preview.
 *
 * # Defaults vs Batch
 *   - `autoDetect: true` (OpenCV speech-bubble contours).
 *   - `inpaint: 'fill'` so translated text replaces the original.
 *   - `translationDomain: 'manga'` for natural conversational tone.
 *   The user can override via Settings, but these defaults are picked
 *   so a fresh manga page yields a usable result on the first run.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessResultLike } from '../../serialize.js';
import type { SerializedProcessResult, Settings } from '../../shared/types.js';
import { ResultPanel } from '../components/ResultPanel.js';
import { InpaintCanvas } from '../components/InpaintCanvas.js';

interface MangaModeProps {
  settings: Settings;
}

interface PanelState {
  path: string;
  source: ImageData | null;
  result: ProcessResultLike | null;
  running: boolean;
  error: string | null;
}

export function MangaMode({ settings }: MangaModeProps): JSX.Element {
  const [panels, setPanels] = useState<PanelState[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [target, setTarget] = useState<string>(settings.defaultTargetLanguage ?? 'en');
  const [autoDetect, setAutoDetect] = useState(true);
  const [fontFamily, setFontFamily] = useState(settings.font.family ?? 'Noto Sans');
  const [fontBold, setFontBold] = useState(settings.font.bold ?? false);

  const current = panels[currentIdx] ?? null;
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx < panels.length - 1;

  // Arrow-key panel nav.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowLeft' && hasPrev) setCurrentIdx((i) => i - 1);
      else if (e.key === 'ArrowRight' && hasNext) setCurrentIdx((i) => i + 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasPrev, hasNext]);

  const onPickPanels = async () => {
    const picked = await window.shell.openFilePicker({ multi: true });
    if (!picked) return;
    setPanels(
      picked.map((path) => ({ path, source: null, result: null, running: false, error: null }))
    );
    setCurrentIdx(0);
  };

  // Lazy-decode the current panel's source image when it becomes
  // current (saves work for big batches).
  useEffect(() => {
    const p = panels[currentIdx];
    if (!p || p.source) return;
    void (async () => {
      try {
        const blob = await fetch(`file://${p.path.replace(/\\/g, '/')}`).then((r) => r.blob());
        const buffer = await blob.arrayBuffer();
        const bmp = await createImageBitmap(new Blob([buffer]));
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(bmp, 0, 0);
        const image = ctx.getImageData(0, 0, bmp.width, bmp.height);
        setPanels((prev) =>
          prev.map((q, i) => (i === currentIdx ? { ...q, source: image } : q))
        );
      } catch (cause) {
        setPanels((prev) =>
          prev.map((q, i) =>
            i === currentIdx
              ? { ...q, error: cause instanceof Error ? cause.message : String(cause) }
              : q
          )
        );
      }
    })();
  }, [currentIdx, panels]);

  const onProcess = async () => {
    const p = panels[currentIdx];
    if (!p) return;
    setPanels((prev) =>
      prev.map((q, i) => (i === currentIdx ? { ...q, running: true, error: null } : q))
    );
    try {
      const r = await window.polyocr.process(p.path, {
        translate: target,
        inpaint: 'fill',
        translationDomain: 'manga',
        autoDetect,
        font: { family: fontFamily, bold: fontBold },
        output: { text: true, regions: true, image: true }
      });
      const reconstructed = reconstruct(r);
      setPanels((prev) =>
        prev.map((q, i) => (i === currentIdx ? { ...q, result: reconstructed, running: false } : q))
      );
    } catch (cause) {
      setPanels((prev) =>
        prev.map((q, i) =>
          i === currentIdx
            ? {
                ...q,
                running: false,
                error: cause instanceof Error ? cause.message : String(cause)
              }
            : q
        )
      );
    }
  };

  const filename = useMemo(() => {
    if (!current) return '';
    return current.path.split(/[\\/]/).pop() ?? current.path;
  }, [current]);

  return (
    <div className="max-w-7xl mx-auto py-6 px-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Manga mode</h1>
        <button
          onClick={onPickPanels}
          className="px-3 py-1 border border-slate-300 rounded hover:bg-slate-50"
        >
          Open panels…
        </button>
      </div>

      {panels.length === 0 ? (
        <div className="border-2 border-dashed border-slate-300 rounded p-12 text-center text-slate-500">
          Open a directory of manga panels to begin. Use ← / → to navigate.
        </div>
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded p-3 flex flex-wrap items-center gap-3 text-sm">
            <button
              onClick={() => setCurrentIdx((i) => i - 1)}
              disabled={!hasPrev}
              className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40"
            >
              ← Prev
            </button>
            <span className="font-mono text-xs">
              {currentIdx + 1}/{panels.length} — {filename}
            </span>
            <button
              onClick={() => setCurrentIdx((i) => i + 1)}
              disabled={!hasNext}
              className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40"
            >
              Next →
            </button>

            <div className="ml-auto flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <div className="text-xs text-slate-600">Target</div>
                <input
                  type="text"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="w-20 border border-slate-300 rounded px-2 py-1 font-mono"
                />
              </label>
              <label className="space-y-1">
                <div className="text-xs text-slate-600">Font family</div>
                <input
                  type="text"
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  className="w-32 border border-slate-300 rounded px-2 py-1 font-mono"
                />
              </label>
              <label className="inline-flex items-center gap-2 mb-1">
                <input
                  type="checkbox"
                  checked={fontBold}
                  onChange={(e) => setFontBold(e.target.checked)}
                />
                <span className="text-xs">bold</span>
              </label>
              <label className="inline-flex items-center gap-2 mb-1">
                <input
                  type="checkbox"
                  checked={autoDetect}
                  onChange={(e) => setAutoDetect(e.target.checked)}
                />
                <span className="text-xs">auto-detect bubbles</span>
              </label>
              <button
                onClick={onProcess}
                disabled={!current || current.running}
                className="px-3 py-1 bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-40"
              >
                {current?.running ? 'Processing…' : 'Process panel'}
              </button>
            </div>
          </div>

          {current?.error && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
              {current.error}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-2">
              {current && (
                <InpaintCanvas source={current.source} result={current.result} />
              )}
            </div>
            <ResultPanel result={current?.result ?? null} loading={current?.running} />
          </div>
        </>
      )}
    </div>
  );
}

function reconstruct(s: SerializedProcessResult): ProcessResultLike {
  return {
    ...s,
    inpaintedImage: s.inpaintedImage
      ? new ImageData(
          s.inpaintedImage.data as Uint8ClampedArray<ArrayBuffer>,
          s.inpaintedImage.width,
          s.inpaintedImage.height
        )
      : null
  };
}
