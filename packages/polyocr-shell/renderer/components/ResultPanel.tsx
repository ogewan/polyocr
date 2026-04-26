/**
 * Result display component.
 *
 * # M3 implementation note
 *   This is the M3 version — covers the field set with minimal styling.
 *   M4 adds polish (color-coded confidence, collapsible long text,
 *   per-region bbox table on click, copy-translation button).
 */

import type { ProcessResultLike } from '../../serialize.js';

export interface ResultPanelProps {
  result: ProcessResultLike | null;
  /** When true, show a "processing…" placeholder. */
  loading?: boolean;
}

export function ResultPanel({ result, loading = false }: ResultPanelProps): JSX.Element {
  if (loading) {
    return (
      <div className="border border-slate-200 rounded p-4 bg-white text-slate-500 text-sm font-mono">
        processing…
      </div>
    );
  }
  if (!result) {
    return (
      <div className="border border-slate-200 rounded p-4 bg-white text-slate-400 text-sm">
        No result yet.
      </div>
    );
  }
  return (
    <div className="border border-slate-200 rounded p-4 bg-white text-sm space-y-3">
      <div className="flex flex-wrap gap-2 items-center text-xs text-slate-500">
        <span>
          Language:{' '}
          <span className="text-slate-700">
            {result.language ?? 'unknown'} ({result.languageConfidence.toFixed(2)})
          </span>
        </span>
        <span>•</span>
        <span>{result.regions.length} region{result.regions.length === 1 ? '' : 's'}</span>
        <span>•</span>
        <span>{result.durationMs.toFixed(0)} ms</span>
        {result.cached && (
          <span className="ml-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px]">
            cached
          </span>
        )}
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1">
          Recognized text
        </div>
        <pre className="whitespace-pre-wrap font-mono text-xs text-slate-800 bg-slate-50 p-2 rounded">
          {result.text || <span className="text-slate-400 italic">(empty)</span>}
        </pre>
      </div>

      {(result.translation || result.translationError) && (
        <div>
          <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1">
            Translation
          </div>
          {result.translation ? (
            <pre className="whitespace-pre-wrap font-mono text-xs text-slate-800 bg-slate-50 p-2 rounded">
              {result.translation}
            </pre>
          ) : (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              {result.translationError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
