/**
 * Optional translation adapter — DeepL.
 *
 * Hits `https://api-free.deepl.com/v2/translate` (or the paid endpoint, configurable).
 * Requires an API key passed in `PolyOCRConfig` or set in `DEEPL_API_KEY` env var.
 *
 * `isAvailable()` requires both:
 *   1. A non-empty API key in config or env.
 *   2. A successful `GET /v2/usage` call (validates the key without consuming
 *      translation quota).
 *
 * `supportedLanguages()` returns DeepL's official source language list, fetched
 * once at construction (cached for the process lifetime — the list rarely changes).
 *
 * Phase 6 implements this in full.
 */
export {};
