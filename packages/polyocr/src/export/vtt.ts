/**
 * WebVTT subtitle exporter.
 *
 * Same model as SRT (`./srt.ts`), but the WebVTT format differs in three ways:
 *   1. The file starts with the literal header `WEBVTT\n\n`.
 *   2. Timestamps use `HH:MM:SS.mmm` (period, not comma).
 *   3. Block indices are optional (we omit them — they add no value and bloat
 *      the file).
 *
 * The web `<track>` element consumes WebVTT, not SRT — so when the export target
 * is "web video subtitle track", VTT is the right choice.
 *
 * Phase 4 implements this in full.
 */
export {};
