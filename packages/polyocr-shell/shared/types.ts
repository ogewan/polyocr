/**
 * Type-only definitions shared between main and renderer.
 *
 * Everything here is pure types — no runtime exports — so both halves
 * can import without bringing the other half's runtime dependencies
 * (better-sqlite3 in main, React in renderer) along for the ride.
 *
 * Why a separate `shared/` directory: keeps main-only modules (db.ts,
 * serialize.ts) out of the renderer bundle and renderer-only modules
 * (everything in renderer/) out of the main bundle, while still letting
 * both reach this one file.
 */

import type { ModelProfile, InpaintMode, FontConfig, OcrOptions } from 'polyocr';

/**
 * Persisted user preferences. Loaded from SQLite on main start, mirrored
 * to the renderer via `window.shell.getSettings()`. Mutations from the
 * Settings page round-trip through `window.shell.setSettings(partial)`
 * which writes to SQLite and re-instantiates the singleton `PolyOCR`.
 */
export interface Settings {
  /** Ollama HTTP URL. Default: `http://localhost:11434`. */
  ollamaUrl: string;
  /** Translation model tag. Default: `aya:8b`. */
  translationModel: string;
  /** Vision model tag (region detection + langdetect fallback). Default: `llama3.2-vision`. */
  visionModel: string;
  /** Whether to register PaddleOCRAdapter (requires Python + paddleocr). */
  enablePaddleOCR: boolean;
  /**
   * PaddleOCR language code passed as `lang` to the adapter. PaddleOCR's
   * own vocabulary (e.g. `'en'`, `'ch'`, `'japan'`, `'korean'`) — NOT
   * shared with `tesseractLanguages` because the encodings and
   * cardinality differ (Tesseract is multi-lang strings like
   * `'eng,jpn'`, PaddleOCR is one ISO-ish code per call). Default `'en'`.
   */
  paddleocrLang: string;
  /**
   * Override the Python binary used to spawn the PaddleOCR bridge.
   * `null` = auto-discover (`python3` on POSIX, `python` on Windows).
   * Set when the user has paddleocr installed in a specific venv.
   */
  paddleocrPythonPath: string | null;
  /** Tesseract language packs. Default: `['eng']`. */
  tesseractLanguages: string[];
  /** Default target language for new sessions. `null` skips translation. */
  defaultTargetLanguage: string | null;
  /** Default inpaint mode. `null` disables inpainting by default. */
  defaultInpaintMode: InpaintMode | null;
  /** Font config used by inpaint fill / chroma. */
  font: FontConfig;
  /** Chroma key color for chroma inpaint mode. Default: `#FF00FF`. */
  chromaKey: string;
  /** Chroma matching tolerance (0–255). Default: 16. */
  chromaTolerance: number;
  /** Tesseract worker count and default batch concurrency. */
  workerCount: number;
  /** Global screenshot hotkey accelerator. Default: `CommandOrControl+Shift+O`. */
  screenshotHotkey: string;
  /** Path to a JSON file of custom `ModelProfile[]` for translation. Null when none. */
  customTranslationProfilesPath: string | null;
}

/** Sensible defaults used on first launch (no settings row yet in SQLite). */
export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://localhost:11434',
  translationModel: 'aya:8b',
  visionModel: 'llama3.2-vision',
  enablePaddleOCR: false,
  paddleocrLang: 'en',
  paddleocrPythonPath: null,
  tesseractLanguages: ['eng'],
  defaultTargetLanguage: null,
  defaultInpaintMode: null,
  font: { family: 'Noto Sans', bold: false, color: '#000000' },
  chromaKey: '#FF00FF',
  chromaTolerance: 16,
  workerCount: 2,
  screenshotHotkey: 'CommandOrControl+Shift+O',
  customTranslationProfilesPath: null
};

/**
 * One row of the `sessions` SQLite table. The renderer's history page
 * lists these in reverse-chronological order.
 */
export interface SessionRecord {
  id: string;
  createdAt: number;
  mode: 'single' | 'batch' | 'manga' | 'screenshot';
  sourcePath: string | null;
  optionsJson: string;
  resultCount: number;
}

/**
 * One row of the `results` table. Inpainted images do NOT live here —
 * they're written to `images/{session_id}/{idx}.png`.
 */
export interface ResultRecord {
  id: string;
  sessionId: string;
  idx: number;
  text: string | null;
  language: string | null;
  translation: string | null;
  durationMs: number;
  cached: boolean;
}

/**
 * IPC-transferable shape of a `ProcessResult`. ImageData is flattened to
 * `{ data, width, height }` because Electron's structured-clone IPC
 * can move `Uint8ClampedArray` but loses the `ImageData` wrapper's
 * `colorSpace` field. `serialize.ts` handles the round-trip.
 */
export interface SerializedProcessResult {
  index: number;
  text: string;
  language: string | null;
  languageConfidence: number;
  regions: Array<{
    text: string;
    bbox: { x: number; y: number; w: number; h: number };
    confidence: number;
    script?: string;
  }>;
  translation: string | null;
  translationError: string | null;
  inpaintedImage: SerializedImageData | null;
  cached: boolean;
  durationMs: number;
}

/** Wire-format ImageData for IPC. `data` is a regular Uint8ClampedArray. */
export interface SerializedImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Subset of `OcrOptions` that the renderer can sensibly send across the
 * IPC boundary. Notably excludes `output.canvas` (a DOM node, not
 * transferable) and `font.color` if it's a non-string CSS value.
 */
export type RendererOcrOptions = Omit<OcrOptions, 'output'> & {
  output?: {
    text?: boolean;
    regions?: boolean;
    image?: boolean;
  };
};

/**
 * Re-exported `ModelProfile` type so renderer code can import from one
 * place rather than reaching into `polyocr/setup`. Keeping the shell's
 * type imports centralized makes future refactors cheaper.
 */
export type { ModelProfile };

/**
 * Setup progress event streamed back from main during `polyocr:setup`.
 */
export interface SetupProgressEvent {
  kind: 'log' | 'pull-progress' | 'done' | 'error';
  message?: string;
  /** Populated for `pull-progress`. */
  pull?: {
    status: string;
    percent?: number;
    completed?: number;
    total?: number;
  };
  /** Populated for `done` and `error`. */
  exitCode?: number;
}
