/**
 * OCR result cache.
 *
 * The cache key is a SHA-256 of the `ImageData.data` buffer (the raw RGBA pixel
 * array). This is the right key because:
 *   - Two identical images always hash the same regardless of source format.
 *   - It's stable across runs (in-memory and SQLite implementations agree).
 *   - It catches the common case in batch workflows where the same frame
 *     appears multiple times (deduplicated video frames, repeated panels,
 *     A/B comparison runs).
 *
 * Only OCR results are cached. Translation is NOT cached because:
 *   - The same text can be translated to many target languages.
 *   - Translation prompts (domain hints) affect the output and would explode
 *     the key space.
 *   - Translation is fast relative to OCR; the win is small and the cache
 *     key complexity isn't worth it.
 */

import type { CacheProvider, OcrResult } from './types.js';
import { PolyOCRError } from './types.js';

/**
 * In-memory LRU-bounded cache. The default cache provider when no other is
 * supplied. Bounded to prevent unbounded memory growth on long-running
 * batch processes — the bound is generous (1000 entries ≈ a few MB of OCR
 * result text) but not infinite.
 */
export class MemoryCache implements CacheProvider {
  private map = new Map<string, OcrResult>();
  private order: string[] = [];
  private readonly limit: number;

  constructor(limit = 1000) {
    this.limit = limit;
  }

  async get(hash: string): Promise<OcrResult | null> {
    const v = this.map.get(hash);
    if (!v) return null;
    // Bump to most-recently-used end of the order list.
    const idx = this.order.indexOf(hash);
    if (idx >= 0) this.order.splice(idx, 1);
    this.order.push(hash);
    return v;
  }

  async set(hash: string, result: OcrResult): Promise<void> {
    if (this.map.has(hash)) {
      const idx = this.order.indexOf(hash);
      if (idx >= 0) this.order.splice(idx, 1);
    }
    this.map.set(hash, result);
    this.order.push(hash);
    while (this.order.length > this.limit) {
      const evict = this.order.shift();
      if (evict !== undefined) this.map.delete(evict);
    }
  }

  async clear(hash?: string): Promise<void> {
    if (hash) {
      this.map.delete(hash);
      const idx = this.order.indexOf(hash);
      if (idx >= 0) this.order.splice(idx, 1);
    } else {
      this.map.clear();
      this.order = [];
    }
  }
}

/**
 * Hash the pixel buffer of an `ImageData` to a hex SHA-256 string.
 *
 * Uses Web Crypto API which is available in Node 20+ as `globalThis.crypto`
 * and in all modern browsers. We hash only the pixel buffer (not the
 * width/height) because two `ImageData` with the same pixels always hash to
 * the same value — width and height are implicitly encoded in the buffer
 * length and content.
 */
export async function hashImageData(data: ImageData): Promise<string> {
  const buffer = data.data.buffer.slice(
    data.data.byteOffset,
    data.data.byteOffset + data.data.byteLength
  );
  try {
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
    if (!subtle) {
      throw new Error('Web Crypto API not available');
    }
    const digest = await subtle.digest('SHA-256', buffer);
    return bufferToHex(digest);
  } catch (cause) {
    throw new PolyOCRError('CACHE_FAILED', 'Failed to compute image hash', cause);
  }
}

function bufferToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}
