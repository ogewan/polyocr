/**
 * CSV exporter.
 *
 * Default columns:
 *   index, text, language, languageConfidence, translation, cached, durationMs
 *
 * Configurable via `ExportOptions.csv.columns` and `.delimiter` (`,` or
 * `\t` for TSV).
 *
 * RFC 4180 quoting:
 *   - Fields containing the delimiter, a `"`, `\n`, or `\r` are wrapped in
 *     `"..."`.
 *   - Embedded `"` characters are doubled (`"hello ""world"""`).
 *
 * Newlines inside cells are preserved (multi-line OCR output ends up as a
 * quoted multi-line cell, NOT collapsed to a space — round-tripping
 * through a parser will recover the original).
 */

import type { ProcessResult, ExportOptions } from '../types.js';

const DEFAULT_COLUMNS: (keyof ProcessResult)[] = [
  'index',
  'text',
  'language',
  'languageConfidence',
  'translation',
  'cached',
  'durationMs'
];

export function toCsv(results: ProcessResult[], options: ExportOptions = { format: 'csv' }): string {
  const columns = (options.csv?.columns ?? DEFAULT_COLUMNS) as (keyof ProcessResult)[];
  const delim = options.csv?.delimiter ?? ',';
  const header = columns.map((c) => quote(String(c), delim)).join(delim);
  const rows = results.map((r) =>
    columns.map((col) => quote(stringify(r[col]), delim)).join(delim)
  );
  return [header, ...rows].join('\n');
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  // Objects (e.g. `regions`, `inpaintedImage`) get JSON-stringified — the
  // user can opt to exclude them via `columns`.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function quote(s: string, delim: string): string {
  // Wrap in double quotes if the cell contains the delimiter, a quote, or
  // a newline. Embedded quotes are doubled per RFC 4180.
  if (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
