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
 * # Why this is intentionally tiny right now
 *   M1 (foundation) only needs an `App` export so `main.tsx` can mount
 *   something. M3 (renderer pages) replaces the page placeholders with
 *   the real Single/Batch/MangaMode/Settings imports + tab navigation.
 *   Keeping this minimal here keeps the M1 commit reviewable.
 */
export function App(): JSX.Element {
  return (
    <div className="min-h-screen flex items-center justify-center text-slate-500">
      <p className="text-sm font-mono">PolyOCR shell — renderer mounting OK (M1 placeholder)</p>
    </div>
  );
}
