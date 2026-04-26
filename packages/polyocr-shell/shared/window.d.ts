/**
 * Augments `Window` with the `polyocr` and `shell` namespaces exposed by
 * `preload.ts` via `contextBridge.exposeInMainWorld`.
 *
 * Lives in `shared/` because both renderer code (consumes the typings)
 * and preload code (must produce something compatible) reference it.
 *
 * Why `unknown` instead of `Buffer` / `Uint8Array` for binary export
 * results: the renderer-side `instanceof` check on a structured-clone-
 * delivered Buffer would fail anyway (Node Buffer has no DOM equivalent
 * the renderer can recognize), so we type the wire format as a plain
 * `Uint8Array` and let the renderer pass it back to `shell.saveFile`
 * without trying to inspect it.
 */

import type {
  Settings,
  SessionRecord,
  ResultRecord,
  SerializedProcessResult,
  SetupProgressEvent,
  RendererOcrOptions,
  ModelProfile
} from './types.js';
import type {
  PolyOCRInput,
  BatchOptions,
  ExportOptions,
  RegionReference,
  BoundingBox
} from 'polyocr';
import type { SetupOptions, SetupResult } from 'polyocr/setup';

/**
 * Renderer-callable surface for `pocr.process` / `processBatch` /
 * `stream` / `export` / `buildReference` / `findRegion` / `setup`.
 *
 * Inputs are restricted to forms the structured-clone IPC can carry:
 * paths (string), data URLs (string), ArrayBuffer, or Uint8Array. The
 * renderer cannot pass File / Blob / HTMLCanvasElement directly — it
 * must read those into ArrayBuffer first via `await file.arrayBuffer()`.
 */
export interface PolyOCRBridge {
  process(
    input: PolyOCRInput,
    options?: RendererOcrOptions
  ): Promise<SerializedProcessResult>;

  processBatch(
    inputs: PolyOCRInput[],
    options?: BatchOptions
  ): Promise<SerializedProcessResult[]>;

  /**
   * Stream results as they arrive. `onResult` is invoked once per
   * result; the returned Promise resolves when the stream completes
   * and rejects if main raises an error mid-stream. Results arrive in
   * completion order (NOT input order) — caller sorts by `.index`.
   */
  stream(
    inputs: PolyOCRInput[],
    options: BatchOptions | undefined,
    onResult: (result: SerializedProcessResult) => void
  ): Promise<void>;

  /**
   * Export results to JSON / CSV / SRT / VTT / ZIP / TXT. The returned
   * Uint8Array is meant to be handed straight to `shell.saveFile`.
   */
  export(
    results: SerializedProcessResult[],
    options: ExportOptions
  ): Promise<Uint8Array>;

  buildReference(crop: PolyOCRInput, label: string): Promise<RegionReference>;
  findRegion(image: PolyOCRInput, reference: RegionReference): Promise<BoundingBox | null>;

  /**
   * Run `polyocr setup`. Progress events stream back via `onProgress`
   * (one per Ollama log line and one per `/api/pull` chunk). The
   * Promise resolves with the final `SetupResult`.
   */
  setup(
    options: SetupOptions,
    onProgress?: (event: SetupProgressEvent) => void
  ): Promise<SetupResult>;

  /** Plain-text dump of the built-in + custom translation profile registry. */
  listProfiles(): Promise<string>;
  /** Structured array of profiles for UI consumption (e.g. a model dropdown). */
  getProfiles(): Promise<ModelProfile[]>;
}

/**
 * Renderer-callable surface for shell-level (non-pipeline) actions.
 * Open / save dialogs, settings persistence, scan history.
 */
export interface ShellBridge {
  openFilePicker(options?: {
    multi?: boolean;
    extensions?: string[];
  }): Promise<string[] | null>;

  openDirectoryPicker(): Promise<string | null>;

  saveFile(bytes: Uint8Array, defaultName: string): Promise<string | null>;

  getSettings(): Promise<Settings>;
  /**
   * Persist a partial settings update. Main re-instantiates the
   * `PolyOCR` singleton if any pipeline-config field changed.
   */
  setSettings(partial: Partial<Settings>): Promise<void>;

  /** Most-recent first, capped at `limit` (default 100). */
  getHistory(limit?: number): Promise<SessionRecord[]>;
  getSessionResults(sessionId: string): Promise<ResultRecord[]>;
  clearHistory(): Promise<void>;

  /**
   * List image files (png/jpg/jpeg/webp/bmp/tiff/gif) directly inside
   * `dirPath`. Returns absolute paths sorted alphabetically. Does NOT
   * recurse — Phase 5 only needs flat enumeration for batch-mode
   * directories.
   */
  listImagesInDir(dirPath: string): Promise<string[]>;
}

declare global {
  interface Window {
    polyocr: PolyOCRBridge;
    shell: ShellBridge;
  }
}

export {};
