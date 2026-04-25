/**
 * WebVTT subtitle exporter.
 *
 * Same model as SRT (`./srt.ts`), but the WebVTT format differs in three
 * ways:
 *   1. The file starts with the literal header `WEBVTT\n\n`.
 *   2. Timestamps use `HH:MM:SS.mmm` (period, not comma).
 *   3. Block indices are optional (we omit them — they add no value and
 *      bloat the file).
 *
 * The web `<track>` element consumes WebVTT, not SRT — when the export
 * target is a web video subtitle track, VTT is the right choice.
 */

import type { ProcessResult, ExportOptions } from '../types.js';

export function toVtt(results: ProcessResult[], options: ExportOptions = { format: 'vtt' }): string {
  const fps = options.fps ?? 1;
  const dt = 1 / fps;
  const lines: string[] = ['WEBVTT', ''];
  const sorted = [...results].sort((a, b) => a.index - b.index);
  for (const r of sorted) {
    const text = (r.translation ?? r.text ?? '').trim();
    if (!text) continue;
    const start = r.index * dt;
    const end = (r.index + 1) * dt;
    lines.push(`${formatVttTime(start)} --> ${formatVttTime(end)}`);
    lines.push(text);
    lines.push('');
  }
  return lines.join('\n');
}

function formatVttTime(seconds: number): string {
  const ms = Math.max(0, Math.floor(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}
