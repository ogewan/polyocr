/**
 * The PolyOCR class — the main user-facing entry point.
 *
 * Owns the configured adapters (OCR, region detection, translation), the
 * cache provider, the worker pool, and the per-call pipeline orchestration.
 *
 * Phase 1 implements `process()` end-to-end with Tesseract + franc + Ollama.
 * Phase 2 will add `processBatch`, `stream`, and the region-matching API.
 * Phase 3 wires inpainting in. Phase 4 adds `export()` and `renderToCanvas()`.
 */

import type {
  PolyOCRConfig,
  PolyOCRInput,
  OcrAdapter,
  OcrOptions,
  ProcessResult,
  TranslationAdapter,
  RegionDetector,
  CacheProvider,
  RegionReference,
  BoundingBox,
  ProcessTimings,
  RecognizedRegion,
  ExportOptions,
  RenderOptions
} from './types.js';
import { PolyOCRError } from './types.js';
import { normalize } from './ingest.js';
import { hashImageData, MemoryCache } from './cache.js';
import { TesseractAdapter } from './ocr/tesseract.js';
import { OllamaTranslationAdapter } from './translate/ollama.js';
import { detectLanguage } from './langdetect.js';

export class PolyOCR {
  public readonly config: Readonly<PolyOCRConfig>;
  private readonly ocr: OcrAdapter;
  private readonly translator: TranslationAdapter;
  private readonly regionDetector: RegionDetector | null;
  private readonly cache: CacheProvider | null;
  private readonly verbose: boolean;

  /**
   * Resolved availability of optional adapters. Populated by `init()` (called
   * lazily on first `process()` call). Consumers can also force-init by
   * awaiting `pocr.ready()` before issuing pipeline calls.
   */
  private availability: {
    ocr: boolean;
    translator: boolean;
    detector: boolean;
  } | null = null;

  private readyPromise: Promise<void> | null = null;

  constructor(config: PolyOCRConfig = {}) {
    this.config = Object.freeze({ ...config });
    this.verbose = config.verbose ?? process?.env?.POLYOCR_VERBOSE === '1';

    // OCR adapter — defaults to Tesseract, overridable via config.
    this.ocr =
      config.ocrAdapter ??
      new TesseractAdapter({
        languages: config.tesseractLanguages,
        workerCount: config.workerCount ?? 2
      });

    // Translation adapter — defaults to Ollama.
    this.translator =
      config.translationAdapter ??
      new OllamaTranslationAdapter({
        ollamaUrl: config.ollamaUrl,
        model: config.translationModel
      });

    // Region detector — null in Phase 1; Phase 2 wires the OpenCV / LLM detectors.
    this.regionDetector = null;

    // Cache — `false` disables, otherwise default to in-memory.
    if (config.cache === false) {
      this.cache = null;
    } else if (config.cache) {
      this.cache = config.cache;
    } else {
      this.cache = new MemoryCache();
    }
  }

  /**
   * Probe all adapters' availability and cache the result. Idempotent — safe
   * to call multiple times.
   */
  async ready(): Promise<void> {
    if (this.availability) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      const [ocr, translator, detector] = await Promise.all([
        this.ocr.isAvailable().catch(() => false),
        this.translator.isAvailable().catch(() => false),
        this.regionDetector ? this.regionDetector.isAvailable().catch(() => false) : Promise.resolve(false)
      ]);
      this.availability = { ocr, translator, detector };
      if (!ocr) {
        // OCR unavailability is fatal — log loudly. The user's pipeline can't
        // do anything useful without it.
        console.warn(`[polyocr] OCR adapter "${this.ocr.name}" failed isAvailable()`);
      }
      if (!translator && this.verbose) {
        console.warn(
          `[polyocr] Translation adapter "${this.translator.name}" failed isAvailable() — translation will be skipped`
        );
      }
    })();
    return this.readyPromise;
  }

  /**
   * Single-image pipeline:
   *   ingest → cache check → OCR → language detect → translate → return.
   *
   * Inpainting (Phase 3) and region filtering (Phase 2) will be inserted at
   * the marked points below.
   */
  async process(input: PolyOCRInput, options: OcrOptions = {}): Promise<ProcessResult> {
    await this.ready();
    const t0 = nowMs();
    const timings: ProcessTimings = { ingest: 0, ocr: 0, langdetect: 0, translate: 0, inpaint: 0 };

    // Stage 1: ingest
    const tIngest = nowMs();
    let image: ImageData;
    try {
      image = await normalize(input);
    } catch (cause) {
      throw cause instanceof PolyOCRError
        ? cause
        : new PolyOCRError('INGEST_FAILED', 'Failed to normalize input', cause);
    }
    timings.ingest = nowMs() - tIngest;

    // Stage 2: cache check (OCR-only)
    const hash = await hashImageData(image);
    let ocrResult = this.cache ? await this.cache.get(hash) : null;
    let cached = !!ocrResult;

    // Stage 3: OCR (if cache miss)
    if (!ocrResult) {
      // Phase 2: ROI / autoDetect / detectWithLLM filtering happens here.
      const tOcr = nowMs();
      try {
        ocrResult = await this.ocr.recognize(image, options);
      } catch (cause) {
        throw cause instanceof PolyOCRError
          ? cause
          : new PolyOCRError('OCR_FAILED', 'OCR adapter failed', cause);
      }
      timings.ocr = nowMs() - tOcr;
      // Apply post-OCR region filters even on a fresh result so the cached
      // value is the unfiltered ground truth (different callers may have
      // different ROI on the same image).
      if (this.cache) await this.cache.set(hash, ocrResult);
    } else if (this.verbose) {
      console.error(`[polyocr] cache hit for ${hash.slice(0, 12)}...`);
    }

    // Apply region filters to OCR output (Phase 2 wires autoDetect + LLM detect; Phase 1 supports
    // only explicit `regions` / `excludeRegions`).
    const filteredRegions = filterRegions(ocrResult.regions, options);
    const filteredText =
      filteredRegions.length === ocrResult.regions.length
        ? ocrResult.text
        : filteredRegions.map((r) => r.text).join('\n').trim();

    // Stage 4: language detection
    const tLang = nowMs();
    const lang = await detectLanguage(filteredText, {
      ollamaUrl: this.config.ollamaUrl,
      model: this.config.translationModel,
      noLlmFallback: !this.availability?.translator
    });
    timings.langdetect = nowMs() - tLang;

    // Stage 5: translation
    const tTrans = nowMs();
    let translation: string | null = null;
    let translationError: string | null = null;
    const wantTranslation = options.translate && options.translate !== lang.language;
    if (wantTranslation) {
      if (!this.availability?.translator) {
        translationError = `translation adapter "${this.translator.name}" unavailable`;
      } else if (lang.language === null) {
        translationError = 'source language could not be determined (numerals-only or empty text)';
      } else if (filteredText.trim() === '') {
        translationError = 'no text to translate';
      } else {
        try {
          translation = await this.translator.translate(
            filteredText,
            lang.language,
            options.translate!,
            options.translationDomain
          );
        } catch (err) {
          translationError =
            err instanceof PolyOCRError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
              ? err.message
              : String(err);
        }
      }
    }
    timings.translate = nowMs() - tTrans;

    // Stage 6: inpainting — Phase 3 wired here.
    let inpaintedImage: ImageData | null = null;

    const result: ProcessResult = {
      index: options.index ?? 0,
      text: filteredText,
      language: lang.language,
      languageConfidence: lang.confidence,
      regions: filteredRegions,
      translation,
      translationError,
      inpaintedImage,
      cached,
      durationMs: nowMs() - t0,
      ...(this.verbose && { timings })
    };

    return result;
  }

  // -- Phase 2 entry points -------------------------------------------------

  async processBatch(inputs: PolyOCRInput[], options: OcrOptions = {}): Promise<ProcessResult[]> {
    // Phase 2: real implementation with worker-pool concurrency.
    const out: ProcessResult[] = [];
    for (let i = 0; i < inputs.length; i++) {
      out.push(await this.process(inputs[i], { ...options, index: i }));
    }
    return out;
  }

  async *stream(inputs: PolyOCRInput[], options: OcrOptions = {}): AsyncGenerator<ProcessResult> {
    // Phase 2: AsyncGenerator with parallel dispatch.
    for (let i = 0; i < inputs.length; i++) {
      yield await this.process(inputs[i], { ...options, index: i });
    }
  }

  async buildReference(_crop: PolyOCRInput, _label: string): Promise<RegionReference> {
    // Phase 2: vision-LLM description, paired with crop + bbox.
    throw new PolyOCRError('DETECT_UNAVAILABLE', 'buildReference is implemented in Phase 2');
  }

  async findRegion(_image: PolyOCRInput, _reference: RegionReference): Promise<BoundingBox | null> {
    // Phase 2: delegated to regionDetector.findSimilar.
    throw new PolyOCRError('DETECT_UNAVAILABLE', 'findRegion is implemented in Phase 2');
  }

  // -- Phase 4 entry points -------------------------------------------------

  async export(_results: ProcessResult[], _options: ExportOptions): Promise<Blob | Buffer> {
    throw new PolyOCRError('EXPORT_FAILED', 'export is implemented in Phase 4');
  }

  renderToCanvas(_result: ProcessResult, _canvas: HTMLCanvasElement, _options?: RenderOptions): void {
    // Phase 4: implements 'inpainted' / 'overlay' / 'bboxes-only' modes.
    throw new PolyOCRError('INVALID_OPTIONS', 'renderToCanvas is implemented in Phase 4');
  }

  /**
   * Release worker pools, kill subprocess bridges, close DB handles. Safe to
   * call multiple times.
   */
  async dispose(): Promise<void> {
    if (this.ocr.dispose) await this.ocr.dispose();
  }
}

/**
 * Apply explicit `regions` (include) and `excludeRegions` filters to OCR
 * output. Phase 2 will additionally support `autoDetect` and `detectWithLLM`
 * — those produce the `regions` list before this function runs.
 */
function filterRegions(regions: RecognizedRegion[], options: OcrOptions): RecognizedRegion[] {
  let out = regions;
  if (options.regions && options.regions.length > 0) {
    out = out.filter((r) => options.regions!.some((box) => bboxOverlaps(r.bbox, box)));
  }
  if (options.excludeRegions && options.excludeRegions.length > 0) {
    out = out.filter((r) => !options.excludeRegions!.some((box) => bboxOverlaps(r.bbox, box)));
  }
  return out;
}

function bboxOverlaps(a: BoundingBox, b: BoundingBox): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}
