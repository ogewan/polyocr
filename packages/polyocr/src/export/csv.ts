/**
 * CSV exporter.
 *
 * Default columns:
 *   index, text, language, languageConfidence, translation, cached, durationMs
 *
 * Configurable via `ExportOptions.csv.columns` and `.delimiter` (`,` or `\t`).
 *
 * RFC 4180 quoting:
 *   - Fields containing the delimiter, a `"`, `\n`, or `\r` are wrapped in `"..."`.
 *   - Embedded `"` characters are doubled (`"hello ""world"""`).
 *
 * Newlines inside cells are preserved (multi-line OCR output should end up as
 * a quoted multi-line cell, NOT collapsed to a space — round-tripping through
 * a CSV parser will recover the original).
 *
 * Phase 4 implements this in full.
 */
export {};
