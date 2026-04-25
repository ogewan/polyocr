/**
 * Two-tier language detection.
 *
 * Tier 1 — `franc` (statistical n-gram detector):
 *   - Fast, deterministic, no model.
 *   - Reliable when text length ≥ 30 chars in clean script.
 *   - Returns ISO 639-3 codes.
 *   - We accept its output if confidence ≥ 0.7. (Below that, we drop down to
 *     the LLM tier — franc's confidence on short / mixed input is usually
 *     overstated and the LLM does materially better on those cases.)
 *
 * Tier 2 — Ollama (LLM fallback):
 *   - For text shorter than 30 chars, mixed-script content, or low-confidence
 *     franc output. We send a JSON-format prompt asking for
 *     `{ language, confidence, script }`.
 *   - Vision models can read straight from the image when OCR text is too
 *     noisy to detect from at all (`detectFromImage` exposes that path).
 *
 * Special case — numerals-only input (`123.45`, `2024-01-15`, `42°C`):
 * `language` returns `null` and translation should be suppressed by the
 * caller. There's no language to detect; translating numerals produces
 * hallucinations.
 */

import type { PolyOCRErrorCode } from './types.js';

export interface LanguageDetection {
  /** ISO 639-3 (franc) or 639-1 (LLM) — caller normalizes if needed. May be `null` for numerals-only. */
  language: string | null;
  /** Detection confidence 0..1. */
  confidence: number;
  /** Optional script tag (`'Latn'`, `'Hans'`, `'Cyrl'`, ...). */
  script: string | null;
  /** Which tier produced this result. */
  source: 'franc' | 'ollama' | 'numerals' | 'empty';
}

const FRANC_MIN_LENGTH = 30;
const FRANC_ACCEPT_CONFIDENCE = 0.7;

export interface DetectLanguageOptions {
  ollamaUrl?: string;
  /** Model name for the LLM tier. Default `aya:8b`. */
  model?: string;
  /** Skip the Ollama fallback even if franc is uncertain. Default false. */
  noLlmFallback?: boolean;
}

/**
 * Detect the language of a text snippet.
 */
export async function detectLanguage(
  text: string,
  opts: DetectLanguageOptions = {}
): Promise<LanguageDetection> {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { language: null, confidence: 0, script: null, source: 'empty' };
  }

  // Numerals-only fast path. We strip whitespace and common numeric punctuation
  // (period, comma, dash, colon, percent, degree, currency symbols) and check
  // if anything alphabetic remains. If not, there's no language to detect.
  const stripped = trimmed.replace(/[\d\s.,:\-+%°$€£¥/()]/g, '');
  if (stripped.length === 0) {
    return { language: null, confidence: 1, script: null, source: 'numerals' };
  }

  // Tier 1: franc.
  if (trimmed.length >= FRANC_MIN_LENGTH) {
    const result = await runFranc(trimmed);
    if (result.confidence >= FRANC_ACCEPT_CONFIDENCE && result.language !== 'und') {
      return { ...result, source: 'franc' };
    }
  }

  // Tier 2: LLM fallback.
  if (!opts.noLlmFallback) {
    try {
      const llm = await detectViaOllama(trimmed, opts);
      if (llm) return { ...llm, source: 'ollama' };
    } catch {
      // Fall through to franc-only result.
    }
  }

  // Last resort — return whatever franc said even at low confidence (better
  // than nothing if the user's pipeline really wants *some* language tag).
  const fallback = await runFranc(trimmed);
  return { ...fallback, source: 'franc' };
}

/**
 * Detect language directly from an image using a vision LLM. Used when OCR
 * has produced no output (or output too noisy to detect from) but the image
 * presumably contains text.
 *
 * Returns the same shape as `detectLanguage`. The model is asked to identify
 * the script + dominant language visible in the image.
 */
export async function detectFromImage(
  image: ImageData,
  opts: { ollamaUrl?: string; visionModel?: string } = {}
): Promise<LanguageDetection> {
  const ollamaUrl = opts.ollamaUrl ?? 'http://localhost:11434';
  const visionModel = opts.visionModel ?? 'llama3.2-vision';

  const b64 = await imageDataToBase64Png(image);
  const prompt = LANG_FROM_IMAGE_PROMPT;
  const body = {
    model: visionModel,
    prompt,
    images: [b64],
    format: 'json',
    stream: false
  };
  const res = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    return { language: null, confidence: 0, script: null, source: 'ollama' };
  }
  const json = (await res.json()) as { response?: string };
  return parseOllamaLangResponse(json.response ?? '', 'ollama');
}

async function runFranc(text: string): Promise<Omit<LanguageDetection, 'source'>> {
  const { franc, francAll } = await import('franc');
  // `francAll` returns ranked candidates with their confidence-like scores
  // (0..1). The top score is normalized so the highest is exactly 1; we
  // attenuate by the gap to the second-best to get a more honest confidence.
  const ranked = francAll(text);
  if (!ranked.length) {
    return { language: 'und', confidence: 0, script: null };
  }
  const [top, second] = ranked;
  const topCode = top[0];
  if (topCode === 'und') {
    return { language: 'und', confidence: 0, script: null };
  }
  const gap = second ? top[1] - second[1] : top[1];
  const confidence = Math.min(1, top[1] * (0.6 + gap * 2));
  // We don't know franc's script from its output alone; we'd need the
  // separate `franc-min` `iso6393-to-iso15924` map. Leave script null.
  return { language: topCode, confidence, script: null };
}

async function detectViaOllama(
  text: string,
  opts: DetectLanguageOptions
): Promise<LanguageDetection | null> {
  const ollamaUrl = opts.ollamaUrl ?? 'http://localhost:11434';
  const model = opts.model ?? 'aya:8b';
  const body = {
    model,
    prompt: LANG_FROM_TEXT_PROMPT.replace('__TEXT__', text.slice(0, 2000)),
    format: 'json',
    stream: false
  };
  const res = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { response?: string };
  return parseOllamaLangResponse(json.response ?? '', 'ollama');
}

function parseOllamaLangResponse(raw: string, source: LanguageDetection['source']): LanguageDetection {
  // LLMs sometimes wrap their output in code fences or add prose. Find the
  // first {, take to the matching }, attempt parse. On any failure, return a
  // null result — the caller decides whether to retry, fall back, or give up.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { language: null, confidence: 0, script: null, source };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      language?: string | null;
      confidence?: number;
      script?: string | null;
    };
    return {
      language: parsed.language ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      script: parsed.script ?? null,
      source
    };
  } catch {
    return { language: null, confidence: 0, script: null, source };
  }
}

async function imageDataToBase64Png(image: ImageData): Promise<string> {
  // Browser / worker path
  if (typeof OffscreenCanvas !== 'undefined' && typeof Blob !== 'undefined') {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get OffscreenCanvas 2D context');
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await blob.arrayBuffer();
    return arrayBufferToBase64(buf);
  }
  // Node fallback via @napi-rs/canvas
  const canvasMod = await import('@napi-rs/canvas');
  const c = canvasMod.createCanvas(image.width, image.height);
  const ctx = c.getContext('2d');
  ctx.putImageData(image as any, 0, 0);
  const buf = await c.encode('png');
  return Buffer.from(buf).toString('base64');
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bytes).toString('base64');
}

/**
 * Prompts kept as named constants (not inline) so they're easy to tune
 * without diving into surrounding code.
 *
 * Each phrase has a reason it's in the prompt:
 *   - "Return ONLY a JSON object" — without this, models prepend "Sure, here is..."
 *   - "Use ISO 639-1 codes"        — otherwise we get inconsistent name/code mixes.
 *   - "If unable to determine"     — without this, the model invents an answer.
 *   - "script field"               — gives us a coarse fallback when language is uncertain.
 */
const LANG_FROM_TEXT_PROMPT = `Identify the language of the following text.

Return ONLY a JSON object of the form:
{"language": "<ISO 639-1 code or null>", "confidence": <0.0-1.0>, "script": "<Latn|Hans|Hant|Hira|Kana|Hang|Cyrl|Arab|Deva|...|null>"}

Use ISO 639-1 codes (en, fr, ja, zh, ar, ...). If unable to determine, set language to null and confidence to 0.

Text:
"""
__TEXT__
"""`;

const LANG_FROM_IMAGE_PROMPT = `Identify the dominant language of any text visible in this image.

Return ONLY a JSON object of the form:
{"language": "<ISO 639-1 code or null>", "confidence": <0.0-1.0>, "script": "<Latn|Hans|Hant|Hira|Kana|Hang|Cyrl|Arab|Deva|...|null>"}

If no text is visible or you cannot determine the language, set language to null and confidence to 0.`;

// We re-export the error code type only so dependent modules can match on
// 'LANGDETECT_FAILED' from the same import surface.
export type { PolyOCRErrorCode };
