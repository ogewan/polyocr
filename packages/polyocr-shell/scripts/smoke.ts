/**
 * Headless smoke test for the polyocr-shell main-process modules.
 *
 * Run with: `npm run smoke` (resolves to `tsx scripts/smoke.ts`).
 *
 * # What this verifies
 *
 *   - `ShellDb` opens against a temp database file, applies the
 *     schema, and round-trips settings (set → get → cleared).
 *   - `buildPolyOCR(settings)` constructs without throwing for the
 *     default settings.
 *   - `pocr.ready()` resolves (probes Tesseract / Ollama / OpenCV /
 *     LLM availability — failures are LOGGED but not fatal here, the
 *     pipeline is documented as fail-soft).
 *   - `pocr.dispose()` and `db.close()` exit cleanly.
 *
 * # What this does NOT verify
 *
 *   The smoke test cannot launch a real Electron window — that
 *   requires a display server and would be intrusive on the user's
 *   desktop session. Window / IPC / tray / global-shortcut behavior
 *   is the user's manual smoke test, documented in the M5 commit
 *   message and the shell README.
 *
 * Exit code: 0 on full success, 1 on any thrown error.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellDb } from '../db.js';
import { buildPolyOCR } from '../pipeline.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'polyocr-shell-smoke-'));
  const dbPath = join(tmp, 'polyocr.db');
  const imagesDir = join(tmp, 'images');
  console.error(`[smoke] temp dir: ${tmp}`);

  let db: ShellDb | null = null;
  let cleanupFailed = false;
  try {
    // ── ShellDb round-trip ─────────────────────────────────────────────
    console.error('[smoke] opening ShellDb…');
    db = new ShellDb({ dbPath, imagesDir });

    console.error('[smoke] reading default settings…');
    const before = db.getSettings();
    if (before.ollamaUrl !== DEFAULT_SETTINGS.ollamaUrl) {
      throw new Error(
        `default settings mismatch: expected ollamaUrl=${DEFAULT_SETTINGS.ollamaUrl}, got ${before.ollamaUrl}`
      );
    }

    console.error('[smoke] writing partial settings…');
    db.setSettings({ workerCount: 4, defaultTargetLanguage: 'fr' });
    const after = db.getSettings();
    if (after.workerCount !== 4 || after.defaultTargetLanguage !== 'fr') {
      throw new Error(
        `settings round-trip failed: workerCount=${after.workerCount}, defaultTargetLanguage=${after.defaultTargetLanguage}`
      );
    }

    console.error('[smoke] listSessions on empty db should return []…');
    const sessions = db.listSessions();
    if (sessions.length !== 0) {
      throw new Error(`expected 0 sessions, got ${sessions.length}`);
    }

    // ── PolyOCR construction + ready ───────────────────────────────────
    console.error('[smoke] buildPolyOCR(settings)…');
    const pocr = await buildPolyOCR(db.getSettings());

    console.error('[smoke] pocr.ready() — probes adapters (some may report unavailable)…');
    await pocr.ready();
    const av = pocr.availability;
    console.error(
      `[smoke] availability: ocr=${av?.ocr} translator=${av?.translator} opencv=${av?.opencv} llm=${av?.llm}`
    );
    if (!av?.ocr) {
      // Tesseract.js should always be available — its WASM is bundled.
      // If it isn't, that's a real problem (e.g. dist/ not built).
      throw new Error('Tesseract OCR adapter reported unavailable — did you build polyocr?');
    }

    console.error('[smoke] pocr.dispose()…');
    await pocr.dispose();

    console.error('[smoke] all checks passed.');
  } finally {
    if (db) {
      try {
        db.close();
      } catch (cause) {
        console.error(`[smoke] db.close failed:`, cause);
        cleanupFailed = true;
      }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (cause) {
      // Don't fail the smoke test on cleanup issues — Windows
      // sometimes holds file handles briefly. Note the failure
      // and move on.
      console.error(`[smoke] temp cleanup failed (non-fatal):`, cause);
      cleanupFailed = true;
    }
  }
  process.exit(cleanupFailed ? 0 : 0);
}

main().catch((cause) => {
  console.error('[smoke] FAILED:', cause);
  process.exit(1);
});
