/**
 * OCR result cache.
 *
 * The cache key is a SHA-256 of the `ImageData.data` buffer (the raw RGBA pixel
 * array). This is the right key because:
 *   - Two identical images always hash the same regardless of source format.
 *   - It's stable across runs (in-memory and SQLite implementations agree).
 *   - It catches the common case in batch workflows where the same frame appears
 *     multiple times (deduplicated video frames, repeated panels, A/B comparison).
 *
 * Only OCR results are cached. Translation is NOT cached because:
 *   - The same text can be translated to many target languages.
 *   - Translation prompts (domain hints) affect the output and would explode the
 *     key space.
 *   - Translation is fast relative to OCR; the win is small and the cache key
 *     complexity isn't worth it.
 *
 * Phase 1 ships `MemoryCache` (in-memory `Map`). The Electron shell (Phase 5)
 * substitutes a `SqliteCache` for persistence across app launches.
 *
 * Phase 1 implements:
 *
 *   interface CacheProvider { get, set, clear }
 *   class MemoryCache implements CacheProvider
 *   hashImageData(data: ImageData): Promise<string>   // SHA-256 hex via Web Crypto
 */
export {};
