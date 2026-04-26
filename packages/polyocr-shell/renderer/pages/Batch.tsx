/**
 * Batch processing page — pick a directory, configure options, watch a
 * streamed progress table fill in, export to JSON / CSV / SRT / VTT /
 * ZIP / TXT.
 *
 * # Streaming UX
 *   Results arrive in completion order (NOT input order — see
 *   BatchProcessor JSDoc in polyocr). The table sorts by
 *   `result.index` so the UI shows them in input order anyway, with
 *   each row populating as the stream yields.
 */

import { useState } from 'react';
import type { ProcessResultLike } from '../../serialize.js';
import type { SerializedProcessResult, Settings } from '../../shared/types.js';
import type { ExportOptions, InpaintMode } from 'polyocr';
import { ResultPanel } from '../components/ResultPanel.js';

interface BatchProps {
  settings: Settings;
}

type ExportFormat = NonNullable<ExportOptions['format']>;

export function Batch({ settings }: BatchProps): JSX.Element {
  const [dir, setDir] = useState<string | null>(null);
  const [target, setTarget] = useState<string>(settings.defaultTargetLanguage ?? '');
  const [inpaint, setInpaint] = useState<InpaintMode | ''>(settings.defaultInpaintMode ?? '');
  const [autoDetect, setAutoDetect] = useState(false);
  const [detectWithLLM, setDetectWithLLM] = useState(false);
  const [concurrency, setConcurrency] = useState(settings.workerCount);
  const [format, setFormat] = useState<ExportFormat>('json');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SerializedProcessResult[]>([]);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const sortedResults = [...results].sort((a, b) => a.index - b.index);

  const [enumeratedFiles, setEnumeratedFiles] = useState<string[]>([]);
  const [enumerating, setEnumerating] = useState(false);

  const onPickDir = async () => {
    const picked = await window.shell.openDirectoryPicker();
    if (!picked) return;
    setDir(picked);
    setResults([]);
    setError(null);
    setCompleted(0);
    setTotal(0);
    setEnumerating(true);
    try {
      const files = await window.shell.listImagesInDir(picked);
      setEnumeratedFiles(files);
      setTotal(files.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setEnumeratedFiles([]);
    } finally {
      setEnumerating(false);
    }
  };

  const onRun = async () => {
    // Two source modes: either the user picked a directory (preferred —
    // Batch is meant for "process this folder of frames"), or they
    // multi-selected files via the alternate picker. Both end up as a
    // string[] of absolute paths.
    let files = enumeratedFiles;
    if (files.length === 0) {
      const picked = await window.shell.openFilePicker({ multi: true });
      if (!picked || picked.length === 0) return;
      files = picked;
      setTotal(files.length);
    }
    setRunning(true);
    setError(null);
    setResults([]);
    setCompleted(0);
    try {
      await window.polyocr.stream(
        files,
        {
          ...(target && { translate: target }),
          ...(inpaint && { inpaint: inpaint as InpaintMode }),
          autoDetect,
          detectWithLLM,
          concurrency,
          output: { text: true, regions: true, image: !!inpaint }
        },
        (r) => {
          setResults((prev) => [...prev, r]);
          setCompleted((n) => n + 1);
        }
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  const onExport = async () => {
    if (results.length === 0) return;
    const bytes = await window.polyocr.export(results, { format });
    const ext =
      format === 'zip'
        ? 'zip'
        : format === 'json'
        ? 'json'
        : format === 'csv'
        ? 'csv'
        : format === 'srt'
        ? 'srt'
        : format === 'vtt'
        ? 'vtt'
        : 'txt';
    await window.shell.saveFile(bytes, `polyocr-batch.${ext}`);
  };

  const selectedResult: ProcessResultLike | null =
    selected !== null
      ? toRendererResult(sortedResults.find((r) => r.index === selected) ?? null)
      : null;

  return (
    <div className="max-w-7xl mx-auto py-6 px-4 space-y-4">
      <h1 className="text-2xl font-semibold">Batch</h1>

      <div className="bg-white border border-slate-200 rounded p-4 space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onPickDir}
            className="px-3 py-1 border border-slate-300 rounded hover:bg-slate-50"
          >
            Choose directory…
          </button>
          <span className="text-sm text-slate-600 font-mono truncate">
            {dir ?? <span className="text-slate-400">(none selected)</span>}
          </span>
          {dir && (
            <span className="text-xs text-slate-500">
              {enumerating
                ? 'enumerating…'
                : `${enumeratedFiles.length} image${enumeratedFiles.length === 1 ? '' : 's'}`}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <label className="space-y-1">
            <div className="text-xs text-slate-600">Target language</div>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="en"
              className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
            />
          </label>
          <label className="space-y-1">
            <div className="text-xs text-slate-600">Inpaint</div>
            <select
              value={inpaint}
              onChange={(e) => setInpaint(e.target.value as InpaintMode | '')}
              className="w-full border border-slate-300 rounded px-2 py-1"
            >
              <option value="">none</option>
              <option value="fill">fill</option>
              <option value="blur">blur</option>
              <option value="chroma">chroma</option>
            </select>
          </label>
          <label className="space-y-1">
            <div className="text-xs text-slate-600">Concurrency</div>
            <input
              type="number"
              min={1}
              max={16}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
            />
          </label>
          <label className="space-y-1">
            <div className="text-xs text-slate-600">Export format</div>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
              className="w-full border border-slate-300 rounded px-2 py-1"
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="txt">TXT</option>
              <option value="srt">SRT</option>
              <option value="vtt">VTT</option>
              <option value="zip">ZIP</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoDetect}
              onChange={(e) => setAutoDetect(e.target.checked)}
            />
            <span>Auto-detect regions (OpenCV)</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={detectWithLLM}
              onChange={(e) => setDetectWithLLM(e.target.checked)}
            />
            <span>Vision LLM detection</span>
          </label>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onRun}
            disabled={running}
            className="px-4 py-1.5 bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-40"
          >
            {running ? `Running… (${completed}/${total})` : 'Run batch'}
          </button>
          <button
            onClick={onExport}
            disabled={results.length === 0}
            className="px-4 py-1.5 border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40"
          >
            Export ({format})
          </button>
        </div>

        {total > 0 && (
          <div className="h-2 bg-slate-100 rounded overflow-hidden">
            <div
              className="h-2 bg-brand-500 transition-all"
              style={{ width: `${(completed / total) * 100}%` }}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
          {error}
        </div>
      )}

      {sortedResults.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase tracking-wide text-[10px]">
                <tr>
                  <th className="text-left px-2 py-1">#</th>
                  <th className="text-left px-2 py-1">Lang</th>
                  <th className="text-left px-2 py-1">Text</th>
                  <th className="text-left px-2 py-1">Translation</th>
                  <th className="text-right px-2 py-1">ms</th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((r) => (
                  <tr
                    key={r.index}
                    onClick={() => setSelected(r.index)}
                    className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
                      selected === r.index ? 'bg-brand-50' : ''
                    }`}
                  >
                    <td className="px-2 py-1 font-mono">{r.index}</td>
                    <td className="px-2 py-1 font-mono">{r.language ?? '—'}</td>
                    <td className="px-2 py-1 font-mono truncate max-w-[12rem]">
                      {r.text || <span className="text-slate-400">(empty)</span>}
                    </td>
                    <td className="px-2 py-1 font-mono truncate max-w-[12rem]">
                      {r.translation || <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {r.durationMs.toFixed(0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <ResultPanel result={selectedResult} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Reconstruct a renderer ProcessResult shape from the IPC wire form. */
function toRendererResult(s: SerializedProcessResult | null): ProcessResultLike | null {
  if (!s) return null;
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
