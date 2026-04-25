/**
 * Two-tier language detection.
 *
 * Tier 1 — `franc` (statistical n-gram detector):
 *   - Fast, deterministic, no model.
 *   - Reliable when text length ≥ 30 chars in clean script.
 *   - Returns ISO 639-3 codes.
 *   - We accept its output if confidence ≥ 0.7.
 *
 * Tier 2 — Ollama (vision LLM fallback):
 *   - For text shorter than 30 chars, mixed-script content, or low-confidence
 *     franc output. We send a structured JSON-mode prompt to `aya:8b` (or the
 *     configured translation model) asking for `{ language, confidence, script }`.
 *   - Vision models can read straight from the image when OCR text is too noisy
 *     to detect from at all (passed as a separate path via `detectFromImage`).
 *
 * Special case — numerals-only input (`123.45`, `2024-01-15`, `42°C`): both tiers
 * return `language: null`. Translation is then suppressed by the caller.
 *
 * Phase 1 implements:
 *
 *   detectLanguage(text: string, ollamaUrl: string, opts?: { model?: string }):
 *     Promise<{ language: string | null, confidence: number, script: string | null }>
 *
 *   detectFromImage(image: ImageData, ollamaUrl: string, visionModel: string):
 *     Promise<{ language: string | null, confidence: number, script: string | null }>
 */
export {};
