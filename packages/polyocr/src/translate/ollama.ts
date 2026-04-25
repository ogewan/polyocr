/**
 * Default translation adapter — Ollama with `aya:8b`.
 *
 * Why `aya:8b` is preferred over `llama3.2:3b` for this task:
 *   - Aya is purpose-built for multilingual instruction-following across 23
 *     languages (Cohere's release notes give the exact list).
 *   - 8B parameters is the sweet spot for translation quality on consumer
 *     GPUs (~5 GB VRAM) — small enough to run alongside a vision model,
 *     large enough to handle nuance the 3B Llama struggles with.
 *   - Llama 3.2 3B is a fine fallback when VRAM is tight, but quality on
 *     low-resource languages (Yoruba, Hausa, Telugu) drops noticeably.
 *
 * `translate()` issues a JSON-format request to `/api/generate`. The system-
 * level instructions are folded into the prompt because Ollama's `/api/generate`
 * doesn't have a separate system role (you'd use `/api/chat` for that, but
 * the simpler `/api/generate` is sufficient for one-shot translation).
 */

import type { OcrOptions, TranslationAdapter } from '../types.js';
import { PolyOCRError } from '../types.js';

interface OllamaTranslationConfig {
  ollamaUrl?: string;
  /** Model name. Default `'aya:8b'`. */
  model?: string;
}

/**
 * The 23 languages Aya 8B is officially trained for. Source: Cohere's Aya
 * model card. ISO 639-1 codes.
 */
const AYA_LANGUAGES = [
  'ar', 'zh', 'cs', 'nl', 'en', 'fr', 'de', 'el',
  'he', 'hi', 'id', 'it', 'ja', 'ko', 'fa', 'pl',
  'pt', 'ro', 'ru', 'es', 'tr', 'uk', 'vi'
];

export class OllamaTranslationAdapter implements TranslationAdapter {
  public readonly name = 'ollama';
  private readonly ollamaUrl: string;
  private readonly model: string;

  constructor(config: OllamaTranslationConfig = {}) {
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'aya:8b';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!res.ok) return false;
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      const models = json.models ?? [];
      // Match either exact name (`aya:8b`) or the family prefix (`aya`) so a
      // user with `aya:35b` pulled also passes the probe.
      const family = this.model.split(':')[0];
      return models.some((m) => m.name === this.model || m.name.startsWith(family + ':'));
    } catch {
      return false;
    }
  }

  async translate(
    text: string,
    from: string,
    to: string,
    domain: OcrOptions['translationDomain'] = 'neutral'
  ): Promise<string> {
    if (!text.trim()) return '';
    const prompt = buildPrompt(text, from, to, domain);
    const body = {
      model: this.model,
      prompt,
      format: 'json',
      stream: false,
      options: {
        // temperature kept low so translations are deterministic and faithful.
        // 0.2 is empirically a good tradeoff: low enough for stable output,
        // high enough to avoid the model getting "stuck" on weird repetition
        // for unusual source text.
        temperature: 0.2
      }
    };
    let res: Response;
    try {
      res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      throw new PolyOCRError('TRANSLATE_FAILED', 'Failed to reach Ollama', cause);
    }
    if (!res.ok) {
      throw new PolyOCRError('TRANSLATE_FAILED', `Ollama responded ${res.status}`);
    }
    const json = (await res.json()) as { response?: string };
    return parseTranslation(json.response ?? '');
  }

  supportedLanguages(): string[] {
    return [...AYA_LANGUAGES];
  }
}

function buildPrompt(
  text: string,
  from: string,
  to: string,
  domain: NonNullable<OcrOptions['translationDomain']>
): string {
  const fromHint = from === 'auto' ? '' : `\nThe source language is: ${from}.`;
  const domainInstr = DOMAIN_INSTRUCTIONS[domain] ?? DOMAIN_INSTRUCTIONS.neutral;
  return `You are a translation engine. Translate the following text into ${to}.${fromHint}

${domainInstr}

Return ONLY a JSON object: {"translation": "<the translated text>"}

Source:
"""
${text}
"""`;
}

const DOMAIN_INSTRUCTIONS: Record<NonNullable<OcrOptions['translationDomain']>, string> = {
  neutral:
    'Produce a faithful translation. Preserve formatting (line breaks, punctuation, capitalization).',
  manga:
    'This is dialogue from a comic / manga. Render speech naturally and conversationally. Preserve onomatopoeia transliteration. Keep honorifics where culturally significant.',
  technical:
    'This is technical content. Preserve units, formulas, code, acronyms, and proper nouns verbatim. Translate only the surrounding prose.',
  formal:
    'Use formal register. Avoid slang and contractions. Preserve any titles or honorifics in the source.'
};

/**
 * Extract the `translation` string from the model's JSON output. Tolerant of
 * surrounding prose, code fences, and slightly malformed JSON because LLMs
 * occasionally do all three even when explicitly told not to.
 */
function parseTranslation(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    // Fallback: assume the whole response is the translation. Strip code
    // fences if present.
    return raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { translation?: string };
    if (typeof obj.translation === 'string') return obj.translation;
  } catch {
    // fall through
  }
  return raw.slice(start, end + 1);
}
