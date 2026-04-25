/**
 * Optional translation adapter — LibreTranslate (self-hosted MTL server).
 *
 * Hits a configurable LibreTranslate server (default `http://localhost:5000`).
 * Useful when you want a non-Ollama, non-cloud option — LibreTranslate is light
 * (CPU-runnable), open source, and has lower per-request latency than an LLM.
 *
 * Quality is below Ollama+aya for low-resource languages but competitive on the
 * common pairs (en ↔ {fr, es, de, ja, zh}).
 *
 * `isAvailable()` GETs `{serverUrl}/languages` and verifies the server returns
 * a non-empty list. Optional `apiKey` is passed via `?api_key=` if configured.
 *
 * Phase 6 implements this in full.
 */
export {};
