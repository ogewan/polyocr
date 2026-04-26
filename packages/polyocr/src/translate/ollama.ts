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
import type { ModelProfile } from './profiles.js';
import { resolveProfile } from './profiles.js';

interface OllamaTranslationConfig {
  ollamaUrl?: string;
  /** Model name. Default `'aya:8b'`. */
  model?: string;
  /**
   * Custom `ModelProfile`s to merge in front of the built-in registry. Lets
   * users register private fine-tunes (`mycorp/aya-jp:8b`) so `polyocr setup`
   * and `supportedLanguages()` know what they speak and how big they are.
   */
  customProfiles?: ModelProfile[];
}

/**
 * Granular status returned by `probe()`. The setup module needs to
 * distinguish "daemon down" from "model missing" — a single boolean
 * collapses them and makes it impossible to choose between "install the
 * daemon" and "pull the model".
 */
export type OllamaProbeStatus =
  | 'ready'           // daemon up, configured model present
  | 'daemon-down'     // /api/tags unreachable (ECONNREFUSED, fetch threw)
  | 'daemon-error'    // /api/tags returned non-2xx
  | 'model-missing';  // daemon up, configured model not in list

/**
 * Structured result of an Ollama probe. Used by `polyocr setup` to decide
 * which remediation step to offer (install daemon, start daemon, pull
 * model, or nothing — already ready).
 */
export interface OllamaProbeResult {
  status: OllamaProbeStatus;
  ollamaUrl: string;
  configuredModel: string;
  /** Model tags present on the daemon. Empty when daemon is down/erroring. */
  installedModels: string[];
  /** Raw error text when daemon is down or returned an error response. */
  error?: string;
}

export class OllamaTranslationAdapter implements TranslationAdapter {
  public readonly name = 'ollama';
  private readonly ollamaUrl: string;
  private readonly model: string;
  private readonly customProfiles?: ModelProfile[];

  constructor(config: OllamaTranslationConfig = {}) {
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'aya:8b';
    this.customProfiles = config.customProfiles;
  }

  /**
   * Granular health probe. Distinguishes daemon-down, daemon-error,
   * model-missing, and ready. `polyocr setup` consumes this; everyday
   * pipeline code just calls `isAvailable()`.
   *
   * The family-prefix match (`aya:35b` matches a `model: 'aya:8b'` config)
   * is preserved here from the old `isAvailable()` — see the comment below
   * for why.
   */
  async probe(): Promise<OllamaProbeResult> {
    let res: Response;
    try {
      res = await fetch(`${this.ollamaUrl}/api/tags`);
    } catch (cause) {
      return {
        status: 'daemon-down',
        ollamaUrl: this.ollamaUrl,
        configuredModel: this.model,
        installedModels: [],
        error: cause instanceof Error ? cause.message : String(cause)
      };
    }
    if (!res.ok) {
      return {
        status: 'daemon-error',
        ollamaUrl: this.ollamaUrl,
        configuredModel: this.model,
        installedModels: [],
        error: `${res.status} ${res.statusText}`
      };
    }
    const json = (await res.json().catch(() => ({}))) as { models?: Array<{ name: string }> };
    const installedModels = (json.models ?? []).map((m) => m.name);
    // Match either exact name (`aya:8b`) or the family prefix (`aya:`) so a
    // user with `aya:35b` pulled also passes the probe. Without this, a user
    // who already has a *different* tag from the same family would be told
    // their model is missing.
    const family = this.model.split(':')[0];
    const present = installedModels.some(
      (n) => n === this.model || n.startsWith(family + ':')
    );
    return {
      status: present ? 'ready' : 'model-missing',
      ollamaUrl: this.ollamaUrl,
      configuredModel: this.model,
      installedModels
    };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.probe()).status === 'ready';
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

  /**
   * Returns the language list of the configured model's profile, or `null`
   * when no profile matches (custom or unknown model). `null` signals "any
   * target accepted, but we can't validate it" — the model will still
   * attempt the translation.
   */
  supportedLanguages(): string[] | null {
    const profile = this.getProfile();
    return profile ? [...profile.languages] : null;
  }

  /**
   * The `ModelProfile` matching the configured model, or `null` if no
   * profile matches. Used by `polyocr setup` to render confirmation
   * prompts ("Pull qwen2.5:3b (~1.9 GB)?") and language-list summaries.
   */
  getProfile(): ModelProfile | null {
    return resolveProfile(this.model, this.customProfiles);
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
