/**
 * SRT subtitle exporter.
 *
 * SRT format:
 *
 *   1
 *   00:00:01,000 --> 00:00:02,000
 *   Hello world
 *
 *   2
 *   00:00:02,000 --> 00:00:03,000
 *   Second subtitle
 *
 * Each `ProcessResult` becomes one block:
 *   - Block index = `result.index + 1` (SRT is 1-indexed).
 *   - Start time = `result.index / fps` seconds.
 *   - End time = `(result.index + 1) / fps` seconds (one frame's duration).
 *   - Text = `result.translation` if present, else `result.text`.
 *
 * If `fps` isn't supplied, the exporter falls back to 1 (one second per
 * frame — sensible for image batches that aren't actually video).
 *
 * Timestamp format: `HH:MM:SS,mmm` — note the comma before milliseconds
 * (this is what distinguishes SRT from WebVTT, which uses a period).
 */

import type { ProcessResult, ExportOptions } from '../types.js';

export function toSrt(results: ProcessResult[], options: ExportOptions = { format: 'srt' }): string {
  const fps = options.fps ?? 1;
  const dt = 1 / fps;
  const blocks: string[] = [];
  // Order by index so frames out of completion order still produce the
  // right timeline.
  const sorted = [...results].sort((a, b) => a.index - b.index);
  for (const r of sorted) {
    const text = (r.translation ?? r.text ?? '').trim();
    if (!text) continue;
    const start = r.index * dt;
    const end = (r.index + 1) * dt;
    blocks.push(`${r.index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}`);
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

function formatSrtTime(seconds: number): string {
  const ms = Math.max(0, Math.floor(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}
