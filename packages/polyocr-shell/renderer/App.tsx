/**
 * Top-level React app for the polyocr-shell renderer.
 *
 * Owns:
 *   - The router state (Single | Batch | MangaMode | Settings).
 *   - Settings hydration on mount (`window.shell.getSettings()`).
 *   - A toast / notification surface used by all pages.
 *
 * The app imports nothing from `polyocr` directly — all pipeline calls go
 * through the IPC bridge exposed by `preload.ts`.
 *
 * Phase 5 implements this in full.
 */
export {};
