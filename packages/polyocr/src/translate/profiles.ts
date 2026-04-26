/**
 * Translation model profiles.
 *
 * A `ModelProfile` describes one Ollama-pullable translation model: its tag,
 * which family it belongs to, the languages it speaks, its on-disk size, and
 * a few descriptive tags used by `polyocr setup` to render hints
 * ("recommended for CJK") and confirmation prompts ("Pull qwen2.5:3b (~1.9
 * GB)?").
 *
 * Why a profile registry instead of asking the model itself: there is no
 * standard "tell me your supported languages" endpoint. Each model card
 * publishes its own list; the most reliable path is to mirror those lists
 * here at build time. A wrong list isn't catastrophic — every Ollama model
 * will *attempt* a translation regardless — but listing the supported set
 * lets `polyocr setup` show the user what they're getting and lets a future
 * UI consumer (Electron shell language picker) populate a dropdown.
 *
 * Why user-extensible: a user with a private fine-tune ("mycorp/aya-jp:8b")
 * needs to register its profile so `polyocr setup --model mycorp/aya-jp:8b`
 * knows the size and language coverage. The constructor takes a custom
 * profile array; built-ins are merged in.
 *
 * The language lists below come from each model's official model card. They
 * use ISO 639-1 codes for consistency with `OcrOptions.translate`.
 */

/**
 * Aya 8B / Aya Expanse 8B — Cohere's multilingual instruction-tuned models.
 * Source: Cohere Aya 23 model card; both ship with this exact list.
 */
const AYA_LANGUAGES = [
  'ar', 'zh', 'cs', 'nl', 'en', 'fr', 'de', 'el',
  'he', 'hi', 'id', 'it', 'ja', 'ko', 'fa', 'pl',
  'pt', 'ro', 'ru', 'es', 'tr', 'uk', 'vi'
];

/**
 * Qwen 2.5 — Alibaba's open multilingual family. Officially trained on 29
 * languages with strong CJK performance. Source: Qwen2.5 technical report.
 */
const QWEN25_LANGUAGES = [
  'en', 'zh', 'ja', 'ko', 'fr', 'es', 'pt', 'de',
  'it', 'ru', 'ar', 'hi', 'th', 'vi', 'id', 'ms',
  'tr', 'pl', 'nl', 'cs', 'el', 'he', 'fa', 'ur',
  'bn', 'ta', 'te', 'sw', 'fil'
];

/**
 * Llama 3.2 — Meta's small multilingual models. The model card lists 8
 * officially supported languages; the model can produce others but quality
 * outside this set drops noticeably.
 */
const LLAMA32_LANGUAGES = [
  'en', 'de', 'fr', 'it', 'pt', 'hi', 'es', 'th'
];

/**
 * Gemma 2 — Google's small multilingual family. Primary languages from the
 * Gemma 2 model card; the model is broadly multilingual but quality is best
 * on this subset.
 */
const GEMMA2_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko',
  'zh', 'hi', 'ar', 'ru', 'tr', 'vi'
];

/**
 * Soft tags used by `polyocr setup` to surface "recommended for X" hints.
 * Not enforced — purely advisory.
 */
export type ModelStrength = 'general' | 'cjk' | 'european' | 'low-resource' | 'manga';

/**
 * Describes one Ollama-pullable translation model.
 *
 * Custom profiles can be registered via `PolyOCRConfig.translationProfiles`
 * or via the `--model-profile <json-file>` CLI flag.
 */
export interface ModelProfile {
  /** Ollama tag, e.g. `'qwen2.5:3b'`. Must match what `ollama pull` accepts. */
  name: string;
  /** Model family, e.g. `'aya'`, `'qwen'`, `'llama'`. Used for prefix matching when a user has a different tag from the same family pulled. */
  family: string;
  /** ISO 639-1 codes the model is officially trained for. */
  languages: string[];
  /** Approximate on-disk size in MiB. Used by the setup confirmation prompt. */
  approxSizeMB: number;
  /** Soft tags. `polyocr setup` uses these for "recommended for X" hints. */
  strengths?: ModelStrength[];
  /** Short human description shown by `polyocr setup --list-models`. */
  description?: string;
}

/**
 * Built-in profiles for the models polyocr knows about. Ordered roughly by
 * "recommend first" — the default `aya:8b` is at the top, smaller / more
 * specialized options follow.
 */
export const BUILT_IN_PROFILES: ModelProfile[] = [
  {
    name: 'aya:8b',
    family: 'aya',
    languages: AYA_LANGUAGES,
    approxSizeMB: 5000,
    strengths: ['general', 'low-resource'],
    description: 'Default. Cohere Aya 8B — 23 languages, balanced quality.'
  },
  {
    name: 'aya-expanse:8b',
    family: 'aya',
    languages: AYA_LANGUAGES,
    approxSizeMB: 5100,
    strengths: ['general', 'low-resource'],
    description: 'Newer Aya release. Same languages, generally better instruction following.'
  },
  {
    name: 'qwen2.5:3b',
    family: 'qwen',
    languages: QWEN25_LANGUAGES,
    approxSizeMB: 1900,
    strengths: ['cjk', 'manga'],
    description: 'Lightweight (~1.9 GB). Strong on Japanese/Chinese/Korean — best small option for manga.'
  },
  {
    name: 'qwen2.5:7b',
    family: 'qwen',
    languages: QWEN25_LANGUAGES,
    approxSizeMB: 4400,
    strengths: ['cjk', 'general'],
    description: 'Mid-size. Strong CJK + broad language coverage.'
  },
  {
    name: 'llama3.2:3b',
    family: 'llama',
    languages: LLAMA32_LANGUAGES,
    approxSizeMB: 2000,
    strengths: ['european'],
    description: 'Lightweight. Best on European languages; weaker on CJK and low-resource.'
  },
  {
    name: 'gemma2:2b',
    family: 'gemma',
    languages: GEMMA2_LANGUAGES,
    approxSizeMB: 1600,
    strengths: ['general'],
    description: 'Smallest reasonable option. Quality drops noticeably vs the 3B/8B class.'
  }
];

/**
 * Look up a profile by its tag, then by family prefix, then return null.
 *
 * Matching by family prefix lets a user who has `aya:35b` pulled get the
 * Aya profile back when they pass `--model aya:35b`, even though that
 * specific tag isn't in the built-in registry.
 *
 * Custom profiles take priority over built-ins so a user can override e.g.
 * `qwen2.5:3b`'s language list without forking the package.
 */
export function resolveProfile(
  model: string,
  custom?: ModelProfile[]
): ModelProfile | null {
  const all = [...(custom ?? []), ...BUILT_IN_PROFILES];
  const exact = all.find((p) => p.name === model);
  if (exact) return exact;
  const family = model.split(':')[0];
  return all.find((p) => p.family === family) ?? null;
}

/**
 * Return the merged list of built-ins + custom profiles, with custom ones
 * first so user overrides win when names collide.
 */
export function listProfiles(custom?: ModelProfile[]): ModelProfile[] {
  if (!custom || custom.length === 0) return [...BUILT_IN_PROFILES];
  const customNames = new Set(custom.map((p) => p.name));
  return [...custom, ...BUILT_IN_PROFILES.filter((p) => !customNames.has(p.name))];
}
