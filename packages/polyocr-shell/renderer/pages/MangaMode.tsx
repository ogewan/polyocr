/**
 * Manga mode page.
 *
 * Optimized for translating sequential image panels (manga, comics, scanned
 * graphic novels). Differs from the generic Batch page in that:
 *   - `autoDetect: true` is the default (speech bubble detection).
 *   - The inpaint mode defaults to `'fill'` so translated text replaces
 *     original dialogue in-place.
 *   - The font picker is prominently surfaced — users typically tune the font
 *     to match the comic's aesthetic.
 *   - A panel navigator shows source / inpainted side-by-side with arrow keys
 *     to jump between panels in a directory.
 *
 * The translation domain is locked to `'manga'` (preserving onomatopoeia,
 * conversational register, honorifics). Users can override via Settings.
 *
 * Phase 5 implements this in full.
 */
export {};
