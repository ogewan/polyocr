/**
 * ZIP exporter — bundles multiple content types into a single archive.
 *
 * Uses `jszip` (no native deps, runs in browser + Node).
 *
 * `ExportOptions.zip.include` selects what goes in:
 *   - `'images'` — each `result.inpaintedImage` re-encoded to PNG or WebP and
 *                  written as `images/0001.png`, `images/0002.png`, ...
 *                  (4-digit zero-pad — sorts correctly in any file manager).
 *   - `'csv'`    — full CSV at `results.csv`.
 *   - `'json'`   — full JSON at `results.json`.
 *   - `'txt'`    — one text file per result at `text/0001.txt`, `text/0002.txt`, ...
 *
 * `ExportOptions.zip.imageFormat` chooses `'png'` (lossless, larger) or `'webp'`
 * (lossy with quality=92, ~5x smaller). PNG is the default — it round-trips the
 * inpainted output exactly.
 *
 * `ExportOptions.zip.manifest: true` (default) adds `manifest.json` with:
 *   {
 *     polyocrVersion: "0.1.0",
 *     exportedAt: ISO timestamp,
 *     count: N,
 *     options: { ... full ExportOptions ... },
 *     files: { images: [...], csv: ..., json: ..., txt: [...] }
 *   }
 *
 * Why the manifest matters: a downstream consumer (a re-import tool, a CI
 * verifier) shouldn't have to guess the file layout — the manifest names every
 * file produced and the options used to produce them.
 *
 * Phase 4 implements this in full.
 */
export {};
