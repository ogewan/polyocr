/**
 * Result display component.
 *
 * Shown by Single, Batch, and MangaMode for an individual `ProcessResult`.
 * Surfaces:
 *   - Language + confidence with a color-coded badge (green / yellow /
 *     red — see `confidenceTone` for thresholds).
 *   - Region count / wall-clock duration / cache-hit pill.
 *   - The recognized text. Long bodies (>200 chars) collapse by default
 *     with a "show more" toggle so a 5,000-character newspaper page
 *     doesn't take over the panel.
 *   - The translation, when present. Has a copy-to-clipboard button
 *     with a brief "copied!" confirmation.
 *   - A disclosure that expands into a per-region table with bbox
 *     coordinates and confidence.
 *
 * No state is owned by this component beyond UI toggles (collapse,
 * region disclosure, copy feedback). The result itself comes from the
 * parent.
 */

import { useState } from 'react';
import type { ProcessResultLike } from '../../serialize.js';

const COLLAPSE_THRESHOLD = 200;

export interface ResultPanelProps {
  result: ProcessResultLike | null;
  /** When true, show a "processing…" placeholder. */
  loading?: boolean;
}

export function ResultPanel({ result, loading = false }: ResultPanelProps): JSX.Element {
  const [textExpanded, setTextExpanded] = useState(false);
  const [translationExpanded, setTranslationExpanded] = useState(false);
  const [regionsOpen, setRegionsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const tone = confidenceTone(result.languageConfidence);
  const textTooLong = result.text.length > COLLAPSE_THRESHOLD;
  const translationTooLong =
    !!result.translation && result.translation.length > COLLAPSE_THRESHOLD;

  const onCopy = async () => {
    if (!result.translation) return;
    try {
      await navigator.clipboard.writeText(result.translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can fail in non-secure contexts; surface as a brief
      // change of button label rather than a thrown error.
      setCopied(false);
    }
  };

  return (
    <div className="border border-slate-200 rounded p-4 bg-white text-sm space-y-3">
      <div className="flex flex-wrap gap-2 items-center text-xs text-slate-500">
        <span className={`px-1.5 py-0.5 rounded font-mono ${tone.badge}`}>
          {result.language ?? 'unknown'} · {result.languageConfidence.toFixed(2)}
        </span>
        <span>•</span>
        <span>
          {result.regions.length} region{result.regions.length === 1 ? '' : 's'}
        </span>
        <span>•</span>
        <span>{result.durationMs.toFixed(0)} ms</span>
        {result.cached && (
          <span className="ml-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px]">
            cached
          </span>
        )}
      </div>

      <Block title="Recognized text">
        <pre className="whitespace-pre-wrap font-mono text-xs text-slate-800 bg-slate-50 p-2 rounded">
          {renderTextBody(result.text, textExpanded)}
        </pre>
        {textTooLong && (
          <button
            onClick={() => setTextExpanded((v) => !v)}
            className="text-xs text-brand-600 hover:underline mt-1"
          >
            {textExpanded ? 'Show less' : `Show more (${result.text.length} chars)`}
          </button>
        )}
      </Block>

      {(result.translation || result.translationError) && (
        <Block
          title="Translation"
          right={
            result.translation && (
              <button
                onClick={onCopy}
                className="text-[10px] uppercase tracking-wide text-slate-500 hover:text-slate-800 px-1.5 py-0.5 rounded border border-slate-200"
              >
                {copied ? 'copied!' : 'copy'}
              </button>
            )
          }
        >
          {result.translation ? (
            <>
              <pre className="whitespace-pre-wrap font-mono text-xs text-slate-800 bg-slate-50 p-2 rounded">
                {renderTextBody(result.translation, translationExpanded)}
              </pre>
              {translationTooLong && (
                <button
                  onClick={() => setTranslationExpanded((v) => !v)}
                  className="text-xs text-brand-600 hover:underline mt-1"
                >
                  {translationExpanded
                    ? 'Show less'
                    : `Show more (${result.translation.length} chars)`}
                </button>
              )}
            </>
          ) : (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              {result.translationError}
            </div>
          )}
        </Block>
      )}

      {result.regions.length > 0 && (
        <div>
          <button
            onClick={() => setRegionsOpen((v) => !v)}
            className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-1"
          >
            <span>{regionsOpen ? '▾' : '▸'}</span>
            <span>Regions ({result.regions.length})</span>
          </button>
          {regionsOpen && (
            <div className="mt-1 max-h-64 overflow-y-auto border border-slate-200 rounded">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase tracking-wide text-[10px] sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1">#</th>
                    <th className="text-left px-2 py-1">bbox</th>
                    <th className="text-left px-2 py-1">conf</th>
                    <th className="text-left px-2 py-1">text</th>
                  </tr>
                </thead>
                <tbody>
                  {result.regions.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-mono text-slate-500">{i}</td>
                      <td className="px-2 py-1 font-mono text-slate-600">
                        {Math.round(r.bbox.x)},{Math.round(r.bbox.y)}{' '}
                        {Math.round(r.bbox.w)}×{Math.round(r.bbox.h)}
                      </td>
                      <td className="px-2 py-1 font-mono">
                        {(r.confidence * 100).toFixed(0)}%
                      </td>
                      <td className="px-2 py-1 font-mono truncate max-w-[12rem]">{r.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Block({
  title,
  right,
  children
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function renderTextBody(text: string, expanded: boolean): React.ReactNode {
  if (!text) return <span className="text-slate-400 italic">(empty)</span>;
  if (expanded || text.length <= COLLAPSE_THRESHOLD) return text;
  return text.slice(0, COLLAPSE_THRESHOLD) + '…';
}

/**
 * Confidence thresholds picked to match what franc + Ollama
 * empirically return:
 *   ≥ 0.85 — high (clean script, ≥ 30 chars, single language)
 *   0.5–0.85 — medium (short text, mixed script, or LLM fallback)
 *   < 0.5 — low (numerals-only, near-empty, or genuinely uncertain)
 *
 * Returning the Tailwind class string keeps the color logic in one
 * place so the badge and any future indicators (per-region row, batch
 * table cell) can share thresholds.
 */
function confidenceTone(c: number): { badge: string } {
  if (c >= 0.85) return { badge: 'bg-emerald-100 text-emerald-800' };
  if (c >= 0.5) return { badge: 'bg-amber-100 text-amber-800' };
  return { badge: 'bg-rose-100 text-rose-800' };
}
