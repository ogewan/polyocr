/**
 * Shared TypeScript types for the polyocr package.
 *
 * Every other module imports from this file. Types here are deliberately verbose
 * with JSDoc on every field — this is a learning project as much as a working
 * library, and a future reader should be able to understand what each field is for
 * without spelunking through the implementation.
 *
 * Naming convention: types describing user input (what the caller passes in) end in
 * `Options` or `Config`; types describing pipeline output end in `Result`. Internal
 * shapes that are neither input nor output use a descriptive noun (`BoundingBox`,
 * `MaskRegion`, `RegionReference`).
 */

/**
 * The set of input shapes the package accepts. The `ingest` module normalizes all
 * of these to `ImageData` before the pipeline runs.
 *
 * `string` covers three different things:
 *   - a filesystem path (Node only — detected by absence of `:` in the prefix or by
 *     a leading drive letter / slash)
 *   - a data URL (`data:image/...;base64,...`)
 *   - a bare base64 string (no data URL prefix — the caller asserted it's an image)
 */
export type PolyOCRInput =
  | File
  | Blob
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageData
  | ArrayBuffer
  | string;

/**
 * Configuration passed to the `PolyOCR` constructor. All fields are optional and
 * have documented defaults.
 */
export interface PolyOCRConfig {
  /**
   * URL of the Ollama HTTP API. Used by both the language-detection fallback and
   * the default translation adapter. Default: `http://localhost:11434`.
   */
  ollamaUrl?: string;

  /**
   * Ollama model name for translation. Default: `'aya:8b'`. Any model can be used —
   * `aya:8b` is the recommended default because it's instruction-tuned for the 23
   * languages it supports and produces consistently formatted output.
   */
  translationModel?: string;

  /**
   * Ollama vision model name for region detection and language fallback.
   * Default: `'llama3.2-vision'`. `'moondream2'` is a lighter alternative.
   */
  visionModel?: string;

  /**
   * Number of OCR worker threads to spawn. Default: 2. Each worker holds a Tesseract
   * scheduler in memory; setting this higher than your CPU core count is wasteful.
   */
  workerCount?: number;

  /**
   * Override the default Tesseract OCR adapter. Useful if you've written a custom
   * adapter (e.g. wrapping a hosted OCR service).
   */
  ocrAdapter?: OcrAdapter;

  /**
   * Override the default region detector. Pass `'opencv'`, `'llm'`, or a custom
   * `RegionDetector` instance. Default: `'opencv'`.
   */
  regionDetector?: RegionDetector | 'opencv' | 'llm';

  /**
   * Override the default translation adapter. Default: Ollama with `translationModel`.
   */
  translationAdapter?: TranslationAdapter;

  /**
   * Where to cache OCR results. Defaults to an in-memory `Map`. Pass `false` to
   * disable caching. Pass a `SqliteCache` instance (Electron shell) for persistent
   * caching across runs.
   */
  cache?: CacheProvider | false;

  /**
   * Languages to load into Tesseract. Default: `['eng']`. Add more for better
   * recognition on multilingual images at the cost of larger model downloads.
   * Codes are Tesseract-style (e.g. `'eng'`, `'jpn'`, `'chi_sim'`).
   */
  tesseractLanguages?: string[];

  /**
   * Override default font config used by inpaint fill / chroma modes.
   */
  font?: FontConfig;

  /**
   * Print verbose pipeline timings to stderr. Equivalent to setting
   * `POLYOCR_VERBOSE=1` in the environment.
   */
  verbose?: boolean;
}

/**
 * Per-call options for `pocr.process()` and the per-image stage of batch / stream.
 */
export interface OcrOptions {
  /**
   * Restrict OCR to these regions. Recognized regions outside the union of these
   * boxes are discarded. Mutually compatible with `autoDetect` and `detectWithLLM`
   * (those run first to populate this list if it's empty).
   */
  regions?: BoundingBox[];

  /**
   * Discard recognized regions whose bbox overlaps any of these. Useful for masking
   * out watermarks, page numbers, or known-noisy areas.
   */
  excludeRegions?: BoundingBox[];

  /**
   * Run the OpenCV contour detector before OCR and use its output as the region
   * filter. Cheap. Best for finding speech bubbles and other closed shapes.
   */
  autoDetect?: boolean;

  /**
   * Run the vision-LLM detector before OCR. Expensive but better at finding text
   * regions in complex / unstructured images. Can be combined with `autoDetect`.
   */
  detectWithLLM?: boolean;

  /**
   * ISO target language code for translation (e.g. `'en'`). If omitted or null,
   * translation is skipped.
   */
  translate?: string | null;

  /**
   * Domain hint for the translation adapter. Affects the system prompt for
   * Ollama-based translation. Default: `'neutral'`.
   */
  translationDomain?: 'neutral' | 'manga' | 'technical' | 'formal';

  /**
   * Inpaint mode. Wired in Phase 3.
   */
  inpaint?: InpaintMode;

  /**
   * Chroma key color (used only with `inpaint: 'chroma'`). Default: `'#FF00FF'`.
   */
  chromaKey?: string;

  /**
   * Tolerance for chroma key color matching, in 0–255 RGB-distance units.
   * Default: 16.
   */
  chromaTolerance?: number;

  /**
   * Font config for inpaint fill / chroma modes. Overrides `PolyOCRConfig.font`.
   */
  font?: FontConfig;

  /**
   * Tesseract page-segmentation mode override. See Tesseract docs for valid values.
   */
  psm?: number;

  /**
   * Tesseract OCR Engine Mode. Default 1 (LSTM only).
   */
  oem?: number;

  /**
   * What to populate on the returned `ProcessResult`. See `OutputSpec`.
   */
  output?: OutputSpec;

  /**
   * Stable index used by SRT / VTT export and for ordering streamed results.
   * Set automatically during batch / stream; the user normally does not pass this.
   */
  index?: number;
}

/**
 * Selects which expensive output fields to populate on `ProcessResult`. Defaults
 * to `{ text: true, regions: true }` — extra work like inpainting a full image is
 * opt-in.
 */
export interface OutputSpec {
  /** Populate `result.text`. Default true. */
  text?: boolean;
  /** Populate `result.regions`. Default true. */
  regions?: boolean;
  /** Populate `result.inpaintedImage`. Requires `inpaint` to be set. Default false. */
  image?: boolean;
  /** Also draw the inpainted result onto this canvas. */
  canvas?: HTMLCanvasElement;
}

/**
 * Per-batch options. Extends `OcrOptions` with concurrency and timing.
 */
export interface BatchOptions extends OcrOptions {
  /**
   * Maximum images processed in parallel. Default: `PolyOCRConfig.workerCount`.
   */
  concurrency?: number;

  /**
   * Frames per second. Used by SRT / VTT export to compute timestamps from
   * `result.index`. If omitted, the exporter falls back to one second per index.
   */
  fps?: number;

  /**
   * Override the cache for this batch (e.g. disable caching during a one-off run).
   * Default: inherit from `PolyOCRConfig.cache`.
   */
  cache?: CacheProvider | false;
}

/**
 * What an OCR adapter returns for a single image.
 */
export interface OcrResult {
  /** Joined text from all recognized regions. */
  text: string;
  /** Per-region recognized text + bbox + per-region confidence. */
  regions: RecognizedRegion[];
  /** Optional engine-reported full-image confidence (0–1). */
  confidence?: number;
  /** Engine name that produced this result (e.g. `'tesseract'`, `'paddleocr'`). */
  engine: string;
}

/**
 * One recognized text region. The `bbox` is in image-pixel coordinates with origin
 * at top-left.
 */
export interface RecognizedRegion {
  text: string;
  bbox: BoundingBox;
  confidence: number;
  /** Optional script tag (e.g. `'Latn'`, `'Hans'`) if the engine reports it. */
  script?: string;
}

/**
 * The OCR adapter interface. The default implementation is `TesseractAdapter`;
 * `PaddleOCRAdapter` is the optional Python-bridge alternative.
 */
export interface OcrAdapter {
  /** Stable identifier — used in logs and `OcrResult.engine`. */
  name: string;
  /** Run OCR over an image. Must not throw — return a structured error in `OcrResult` instead if it has to. */
  recognize(image: ImageData, options: OcrOptions): Promise<OcrResult>;
  /** Probe the adapter's dependency. Must not throw. */
  isAvailable(): Promise<boolean>;
  /** Optional cleanup hook. Called by `pocr.dispose()`. */
  dispose?(): Promise<void> | void;
}

/**
 * The translation adapter interface. The default is `OllamaTranslationAdapter`.
 */
export interface TranslationAdapter {
  name: string;
  /**
   * Translate a chunk of text from `from` (ISO 639-1 or `'auto'`) to `to`.
   * `from === 'auto'` means the source language is unknown — adapters may detect
   * it themselves or rely on the LLM to do so.
   */
  translate(text: string, from: string, to: string, domain?: OcrOptions['translationDomain']): Promise<string>;
  /** ISO 639-1 codes the adapter supports as a target language. */
  supportedLanguages(): string[];
  isAvailable(): Promise<boolean>;
}

/**
 * The region detector interface. Two responsibilities:
 *   - `detect`: find candidate text regions in an image (used by `autoDetect`).
 *   - `findSimilar`: locate a previously-built `RegionReference` in a new image
 *     (used by the instrument-readout / drift-tolerance workflow).
 */
export interface RegionDetector {
  name: string;
  detect(image: ImageData, options?: DetectOptions): Promise<BoundingBox[]>;
  /**
   * Returns the bbox in `image` that best matches the reference, or `null` if no
   * confident match. Implementations should fail-soft: if the model can't make a
   * call, return `null` rather than throwing.
   */
  findSimilar(image: ImageData, reference: RegionReference): Promise<BoundingBox | null>;
  isAvailable(): Promise<boolean>;
}

/**
 * Options for `RegionDetector.detect()`.
 */
export interface DetectOptions {
  /** Minimum bbox area in px². Default: 500. */
  minArea?: number;
  /** Acceptable aspect-ratio range (width/height). Default: `[0.3, 3.0]`. */
  aspectRatioRange?: [number, number];
  /** Maximum number of regions to return (sorted by area, descending). */
  limit?: number;
}

/**
 * A reusable description of a region for the LLM matching workflow.
 *
 * Built from a single representative image via `pocr.buildReference(crop, label)`.
 * Reused across many images via `pocr.findRegion(image, reference)` to handle
 * positional drift (e.g. a gauge that moves a few px between frames).
 */
export interface RegionReference {
  /** Human label — e.g. `'pressure-gauge'`. Used for logging only. */
  label: string;
  /** The original cropped pixels — included so a future, vision-equivalent matcher could template-match. */
  crop: ImageData;
  /** The bbox in the *reference* image. */
  bbox: BoundingBox;
  /** Vision-LLM-generated description, e.g. `'a circular pressure gauge with a red needle'`. */
  description: string;
  /**
   * If true, regions matching this reference should be EXCLUDED from OCR. Useful
   * for marking out fixed-location watermarks or logos.
   */
  exclude?: boolean;
}

/**
 * Image-pixel rectangle. Top-left origin.
 */
export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Region of an image keyed by chroma color match. Distinct from `BoundingBox`
 * because chroma masks can be non-rectangular — they're stored as a packed
 * pixel-mask + bbox.
 */
export interface MaskRegion {
  /** Bounding box of the mask. */
  bbox: BoundingBox;
  /** Packed mask. 1 byte per pixel: `0` = not masked, `255` = masked. */
  mask: Uint8ClampedArray;
}

/**
 * The shape returned by `pocr.process()` and yielded by `pocr.stream()`.
 */
export interface ProcessResult {
  /** Stable index in the source array. Drives SRT/VTT timestamps. */
  index: number;
  /** Full recognized text, joined across regions. */
  text: string;
  /** ISO 639-3 detected language code (from franc) or `null` for numerals-only. */
  language: string | null;
  /** Confidence of the language detection (0–1). */
  languageConfidence: number;
  /** Recognized regions — useful for ROI display, inpainting, drawing overlays. */
  regions: RecognizedRegion[];
  /** Translated text, or `null` if translation was not requested or was suppressed. */
  translation: string | null;
  /** Structured error from the translation step, if any. The pipeline still completes. */
  translationError: string | null;
  /** Final inpainted image (only if `output.image` and `inpaint` were set). */
  inpaintedImage: ImageData | null;
  /** True if the OCR result was served from cache. */
  cached: boolean;
  /** Total wall-clock time in ms. */
  durationMs: number;
  /** Optional per-stage timings (populated when `verbose: true` or `POLYOCR_VERBOSE=1`). */
  timings?: ProcessTimings;
}

/**
 * Per-stage timings for performance profiling. All values are wall-clock ms.
 */
export interface ProcessTimings {
  ingest: number;
  ocr: number;
  langdetect: number;
  translate: number;
  inpaint: number;
}

/**
 * Cache provider abstraction. The package ships an in-memory implementation;
 * the Electron shell substitutes a SQLite-backed implementation.
 */
export interface CacheProvider {
  get(hash: string): Promise<OcrResult | null>;
  set(hash: string, result: OcrResult): Promise<void>;
  clear(hash?: string): Promise<void>;
}

/**
 * Inpainting modes.
 *   - `'chroma'`: caller supplies a chroma-keyed mask (e.g. magenta pixels marking text).
 *     Mask regions are filled and the translated text is rendered on top.
 *   - `'blur'`:   Gaussian blur over OCR bboxes. No text rendering. Pure obfuscation.
 *   - `'fill'`:   Sample bbox perimeter pixels → median color → fill bbox interior →
 *                 render translated text using Noto Sans with binary-search font sizing.
 *   - `'clone'`:  Stub. Reserved for v2 content-aware fill (PatchMatch / FFT inpainting).
 */
export type InpaintMode = 'chroma' | 'blur' | 'fill' | 'clone';

/**
 * Font configuration for inpainted text rendering.
 */
export interface FontConfig {
  /** Font family. Default: `'Noto Sans'`. The package bundles a Noto Sans subset. */
  family?: string;
  /** Min font size (px). Default: 8. The binary search won't go below this. */
  minSize?: number;
  /** Max font size (px). Default: 64. */
  maxSize?: number;
  /** Text color. Default: `'#000000'`. */
  color?: string;
  /** Padding inside the bbox before text starts (px). Default: 4. */
  padding?: number;
  /** Bold weight. Default: false. */
  bold?: boolean;
  /** Italic. Default: false. */
  italic?: boolean;
  /** Line height multiplier. Default: 1.2. */
  lineHeight?: number;
}

/**
 * Options for `pocr.renderToCanvas()`.
 */
export interface RenderOptions {
  /**
   * Render mode:
   *   - `'inpainted'` — draws the inpainted image. Requires `inpaint` was run.
   *   - `'overlay'`   — draws the original image, overlays translation text at each bbox.
   *   - `'bboxes-only'` — draws original + colored bbox outlines + region labels.
   */
  mode?: 'inpainted' | 'overlay' | 'bboxes-only';
  /** Bbox stroke color for `'bboxes-only'`. Default: `'#FF0000'`. */
  bboxColor?: string;
  /** Bbox stroke width for `'bboxes-only'`. Default: 2. */
  bboxWidth?: number;
  /** Original source image — required for `'overlay'` and `'bboxes-only'`. */
  source?: ImageData;
}

/**
 * Options for `pocr.export()`.
 */
export interface ExportOptions {
  /** Target format. */
  format: 'json' | 'txt' | 'csv' | 'srt' | 'vtt' | 'zip';
  /** ZIP-specific config. */
  zip?: {
    include: ('images' | 'csv' | 'json' | 'txt')[];
    imageFormat?: 'png' | 'webp';
    /** Include a top-level `manifest.json` describing the export. Default: true. */
    manifest?: boolean;
  };
  /** CSV-specific config. */
  csv?: {
    columns?: (keyof ProcessResult)[];
    delimiter?: ',' | '\t';
  };
  /** Frames per second — needed by SRT/VTT format if not in `BatchOptions`. */
  fps?: number;
}

/**
 * Structured error type. Throwers should construct a `PolyOCRError` with a stable
 * `code` so callers can branch on it. Raw strings are not thrown anywhere in the
 * package.
 */
export class PolyOCRError extends Error {
  public readonly code: PolyOCRErrorCode;
  public readonly cause?: unknown;
  constructor(code: PolyOCRErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'PolyOCRError';
    this.code = code;
    this.cause = cause;
  }
}

/** Stable error codes — callers may match on these to recover or surface specific UX. */
export type PolyOCRErrorCode =
  | 'INGEST_FAILED'
  | 'OCR_UNAVAILABLE'
  | 'OCR_FAILED'
  | 'LANGDETECT_FAILED'
  | 'TRANSLATE_UNAVAILABLE'
  | 'TRANSLATE_FAILED'
  | 'DETECT_UNAVAILABLE'
  | 'DETECT_FAILED'
  | 'INPAINT_FAILED'
  | 'EXPORT_FAILED'
  | 'CACHE_FAILED'
  | 'BRIDGE_SPAWN_FAILED'
  | 'INVALID_INPUT'
  | 'INVALID_OPTIONS';
