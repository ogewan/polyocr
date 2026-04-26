/**
 * Main-process pipeline helpers, extracted from main.ts so they can
 * be exercised by the smoke test (`scripts/smoke.ts`) without
 * importing Electron's runtime.
 *
 * `main.ts` imports `from 'electron'` at the top level, which means
 * anything that imports it pulls in the Electron Node runtime — fine
 * for the actual app, but impossible for a `tsx`-runnable smoke test
 * that wants to verify ShellDb + PolyOCR construction in isolation.
 *
 * These helpers are deliberately Electron-free: they construct a
 * `PolyOCR` instance from a `Settings` object and decide when a
 * pipeline-relevant settings change requires a rebuild. They do NOT
 * touch IPC, windows, the tray, or any other Electron API.
 */

import { readFile } from 'node:fs/promises';
import { PolyOCR, PaddleOCRAdapter } from 'polyocr';
import type { Settings, ModelProfile } from './shared/types.js';

/**
 * Construct a `PolyOCR` from current settings. Custom translation
 * profiles are loaded from the configured JSON file path
 * (best-effort — a missing or malformed file is logged and skipped,
 * not fatal). Returning the constructed instance lets the caller
 * decide when to call `ready()` (which triggers adapter probes).
 */
export async function buildPolyOCR(settings: Settings): Promise<PolyOCR> {
  let customProfiles: ModelProfile[] | undefined;
  if (settings.customTranslationProfilesPath) {
    try {
      const raw = await readFile(settings.customTranslationProfilesPath, 'utf8');
      const parsed = JSON.parse(raw) as ModelProfile[];
      if (Array.isArray(parsed)) customProfiles = parsed;
    } catch (cause) {
      console.warn(
        `[shell/pipeline] failed to load custom translation profiles from ${settings.customTranslationProfilesPath}:`,
        cause instanceof Error ? cause.message : cause
      );
    }
  }
  // When the user has flipped the PaddleOCR toggle in Settings,
  // construct a PaddleOCRAdapter and pass it as `ocrAdapter` so it
  // overrides the built-in Tesseract default. The adapter spawns its
  // Python bridge lazily on first recognize(), so construction here
  // is cheap (no subprocess yet — that cost is paid the first time
  // OCR runs against an image).
  const ocrAdapter = settings.enablePaddleOCR
    ? new PaddleOCRAdapter({
        lang: settings.paddleocrLang,
        ...(settings.paddleocrPythonPath !== null && {
          pythonPath: settings.paddleocrPythonPath
        })
      })
    : undefined;

  return new PolyOCR({
    ollamaUrl: settings.ollamaUrl,
    translationModel: settings.translationModel,
    visionModel: settings.visionModel,
    workerCount: settings.workerCount,
    tesseractLanguages: settings.tesseractLanguages,
    font: settings.font,
    ...(customProfiles && { translationProfiles: customProfiles }),
    ...(ocrAdapter && { ocrAdapter }),
    verbose: process.env.POLYOCR_VERBOSE === '1'
  });
}

/**
 * Returns true if any field that the `PolyOCR` constructor consumes
 * differs between two snapshots. Used by main.ts to decide whether a
 * `setSettings` IPC needs to tear down + rebuild the singleton, or
 * whether the change is purely UI-side (e.g. screenshotHotkey,
 * defaultTargetLanguage).
 *
 * Deep comparison is done via JSON.stringify because the values
 * involved are small (a few-element array, a font config object) and
 * stable in shape — a per-key recursive check would be more code for
 * the same correctness guarantee.
 */
export function pipelineRelevantChanged(a: Settings, b: Settings): boolean {
  return (
    a.ollamaUrl !== b.ollamaUrl ||
    a.translationModel !== b.translationModel ||
    a.visionModel !== b.visionModel ||
    a.workerCount !== b.workerCount ||
    a.enablePaddleOCR !== b.enablePaddleOCR ||
    a.paddleocrLang !== b.paddleocrLang ||
    a.paddleocrPythonPath !== b.paddleocrPythonPath ||
    JSON.stringify(a.tesseractLanguages) !== JSON.stringify(b.tesseractLanguages) ||
    JSON.stringify(a.font) !== JSON.stringify(b.font) ||
    a.customTranslationProfilesPath !== b.customTranslationProfilesPath
  );
}
