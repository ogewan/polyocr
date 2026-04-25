/**
 * Default translation adapter — Ollama with `aya:8b`.
 *
 * Why `aya:8b` is preferred over `llama3.2:3b` for this task:
 *   - Aya is *purpose-built* for multilingual instruction-following across 23
 *     languages (Cohere's release notes give the exact list).
 *   - 8B parameters is the sweet spot for translation quality on consumer GPUs
 *     (~5 GB VRAM) — small enough to run alongside a vision model, large enough
 *     to handle nuance the 3B Llama struggles with.
 *   - Llama 3.2 3B is a fine fallback when VRAM is tight, but quality on
 *     low-resource languages (Yoruba, Hausa, Telugu) drops noticeably.
 *
 * `translate()` issues a chat-style request to `/api/chat`. The system prompt
 * varies by `domain`:
 *   - `'neutral'` — produce a faithful translation; preserve formatting.
 *   - `'manga'`   — preserve onomatopoeia transliteration; render dialogue
 *                  conversationally; keep honorifics where culturally significant.
 *   - `'technical'` — preserve units, formulas, code blocks, and acronyms verbatim.
 *   - `'formal'`  — favor formal register over colloquial.
 *
 * The prompt requests output as a single JSON object `{ "translation": "..." }`
 * which we parse — this avoids the "the translation is: ..." preface that LLMs
 * tend to emit when asked to output bare text.
 *
 * `isAvailable()` GETs `{ollamaUrl}/api/tags` and checks the configured model is
 * present. Network errors → false. Model not pulled → false.
 *
 * `supportedLanguages()` returns the 23 ISO 639-1 codes Aya is tuned for.
 *
 * Phase 1 implements this in full.
 */
export {};
