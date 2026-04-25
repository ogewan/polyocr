/**
 * Formal TranslationAdapter interface.
 *
 * `translate()` is called once per image (after OCR + language detection). The
 * adapter receives the source text, a source language code (or `'auto'` if
 * detection failed / produced low confidence), and a target language code, and
 * must return a translated string.
 *
 * # When to implement this interface
 * Implement a custom adapter when you need:
 *   - A hosted MTL service (DeepL, Google Translate, Azure Translator).
 *   - A self-hosted server (LibreTranslate, Argos Translate).
 *   - A custom prompt pipeline against any LLM provider (OpenAI, Anthropic, etc.).
 *   - Glossary / terminology overrides for technical domains.
 *
 * # What `isAvailable()` is expected to do
 *   - API-key-based adapters: check the key is present in config AND make a cheap
 *     test request (e.g. fetch supported languages).
 *   - Local-server adapters (Ollama, LibreTranslate): hit a health endpoint.
 *   - Confirm the configured target model / language pair is actually supported.
 *
 * `PolyOCR`'s constructor calls this once at startup and caches the result. The
 * pipeline will skip translation (and surface `translationError: 'unavailable'`
 * on `ProcessResult`) rather than throw — so a misleading `isAvailable: true`
 * causes silent translation failures.
 *
 * # Error handling
 * `translate()` may throw `PolyOCRError('TRANSLATE_FAILED', ...)` on failure. The
 * pipeline catches these, populates `result.translationError`, and continues to
 * inpainting / output stages. The caller never sees an exception unwind the whole
 * `process()` call because of a translation glitch.
 */
export type { TranslationAdapter, OcrOptions } from '../types.js';
