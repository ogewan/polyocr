/**
 * The PolyOCR class — the main user-facing entry point.
 *
 * Owns the configured adapters (OCR, region detection, translation), the
 * cache provider, the worker pool, and the per-call pipeline orchestration.
 *
 * Phase 1 implements `process()` end-to-end with Tesseract + franc + Ollama.
 * Phase 2 adds `processBatch`, `stream`, and the region-matching API
 * (buildReference, findRegion, autoDetect, detectWithLLM).
 * Phase 3 will wire inpainting in. Phase 4 adds `export()` and `renderToCanvas()`.
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
  BatchOptions,
  ExportOptions,
  RenderOptions
} from './types.js';
import { PolyOCRError } from './types.js';
import { normalize } from './ingest.js';
import { hashImageData, MemoryCache } from './cache.js';
import { TesseractAdapter } from './ocr/tesseract.js';
import { OllamaTranslationAdapter } from './translate/ollama.js';
import { OpenCVDetector } from './detect/opencv.js';
import { LLMDetector } from './detect/llm.js';
import { detectLanguage } from './langdetect.js';
import { BatchProcessor } from './batch.js';

export class PolyOCR {
  public readonly config: Readonly<PolyOCRConfig>;
  private readonly ocr: OcrAdapter;
  private readonly translator: TranslationAdapter;
  /** OpenCV detector (cheap, contour-based). Used by `autoDetect: true`. */
  private readonly opencvDetector: RegionDetector;
  /** LLM detector (vision model). Used by `detectWithLLM`, `buildReference`, `findRegion`. */
  private readonly llmDetector: RegionDetector;
  private readonly cache: CacheProvider | null;
  private readonly verbose: boolean;
  private readonly defaultConcurrency: number;
  private readonly batch: BatchProcessor;

  /**
   * Resolved availability of optional adapters. Populated by `ready()`
   * (called lazily on first `process()` call).
   */
  private availability: {
    ocr: boolean;
    translator: boolean;
    opencv: boolean;
    llm: boolean;
  } | null = null;

  private readyPromise: Promise<void> | null = null;

  constructor(config: PolyOCRConfig = {}) {
    this.config = Object.freeze({ ...config });
    this.verbose = config.verbose ?? process?.env?.POLYOCR_VERBOSE === '1';
    this.defaultConcurrency = config.workerCount ?? 2;

    // OCR adapter — defaults to Tesseract, overridable via config.
    this.ocr =
      config.ocrAdapter ??
      new TesseractAdapter({
        languages: config.tesseractLanguages,
        workerCount: this.defaultConcurrency
      });

    // Translation adapter — defaults to Ollama.
    this.translator =
      config.translationAdapter ??
      new OllamaTranslationAdapter({
        ollamaUrl: config.ollamaUrl,
        model: config.translationModel
      });

    // Region detectors — we always instantiate both. The user picks via
    // `options.autoDetect` (OpenCV) and/or `options.detectWithLLM` (LLM)
    // per call. Constructor cost is ~0; the WASM / network probes only fire
    // on `isAvailable()` or first use.
    this.opencvDetector =
      typeof config.regionDetector === 'object'
        ? config.regionDetector
        : new OpenCVDetector();
    this.llmDetector = new LLMDetector({
      ollamaUrl: config.ollamaUrl,
      model: config.visionModel
    });

    // Cache — `false` disables, otherwise default to in-memory.
    if (config.cache === false) {
      this.cache = null;
    } else if (config.cache) {
      this.cache = config.cache;
    } else {
      this.cache = new MemoryCache();
    }

    this.batch = new BatchProcessor({
      runOne: (input, options) => this.process(input, options),
      defaultConcurrency: this.defaultConcurrency
    });
  }

  /**
   * Probe all adapters' availability and cache the result.
   */
  async ready(): Promise<void> {
    if (this.availability) return;
    if (this.readyPromise) return this.readyPromise;
    // Each adapter probe is wrapped in a hard timeout so a misbehaving
    // adapter (e.g. a network probe with no socket timeout, or a WASM init
    // that never resolves its onRuntimeInitialized callback) cannot block
    // the whole pipeline. The timeout is cancelled when fn() resolves,
    // otherwise its `setTimeout` would still fire later and log a confusing
    // "timed out" message even on the success path.
    const probe = (name: string, fn: () => Promise<boolean>, timeoutMs = 8000): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fnP = fn().then(
        (v) => {
          if (timer) clearTimeout(timer);
          return v;
        },
        (err) => {
          if (timer) clearTimeout(timer);
          if (this.verbose) console.error(`[polyocr] isAvailable("${name}") threw:`, err);
          return false;
        }
      );
      const timeoutP = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          if (this.verbose) console.error(`[polyocr] isAvailable("${name}") timed out after ${timeoutMs}ms`);
          resolve(false);
        }, timeoutMs);
      });
      return Promise.race([fnP, timeoutP]);
    };
    this.readyPromise = (async () => {
      // Run probes sequentially. Parallel `Promise.all` of multiple
      // adapters' availability probes was observed to deadlock in Node
      // when more than one adapter triggers an Emscripten-WASM import
      // (Tesseract.js, OpenCV.js) — the WASM init paths contend on the
      // event loop and starve other timers. Sequential is slightly slower
      // on cold start (~1–3s total instead of ~1s parallel) but reliable.
      const ocr = await probe('ocr', () => this.ocr.isAvailable());
      const translator = await probe('translator', () => this.translator.isAvailable());
      const opencv = await probe('opencv', () => this.opencvDetector.isAvailable(), 12000);
      const llm = await probe('llm', () => this.llmDetector.isAvailable());
      this.availability = { ocr, translator, opencv, llm };
      if (!ocr) {
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
   *   ingest → autoDetect/LLM detect → cache check → OCR → ROI filter →
   *   language detect → translate → return.
   */
  async process(input: PolyOCRInput, options: OcrOptions = {}): Promise<ProcessResult> {
    await this.ready();
    const t0 = nowMs();
    const timings: ProcessTimings = { ingest: 0, ocr: 0, langdetect: 0, translate: 0, inpaint: 0 };
    const debug = (msg: string) => {
      if (this.verbose) console.error(`[polyocr/process idx=${options.index ?? 0}] ${msg}`);
    };
    debug(`start`);

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
    debug(`ingest done (${timings.ingest.toFixed(0)}ms ${image.width}x${image.height})`);

    // Stage 2: optional pre-OCR region detection. We *augment* (not replace)
    // any explicitly-supplied `regions` so a caller who already knows part
    // of the layout can combine it with auto-detection.
    let resolvedRegions = options.regions;
    if (options.autoDetect && this.availability?.opencv) {
      const detected = await this.opencvDetector.detect(image).catch(() => []);
      resolvedRegions = mergeRegions(resolvedRegions, detected);
    }
    if (options.detectWithLLM && this.availability?.llm) {
      const detected = await this.llmDetector.detect(image).catch(() => []);
      resolvedRegions = mergeRegions(resolvedRegions, detected);
    }
    const effectiveOptions: OcrOptions = { ...options, regions: resolvedRegions };

    // Stage 3: cache check (OCR-only). The cache key is the pixel hash —
    // identical to what was passed to OCR — so it's stable across cache
    // hits regardless of the per-call options.
    const hash = await hashImageData(image);
    debug(`hash=${hash.slice(0, 12)}`);
    let ocrResult = this.cache ? await this.cache.get(hash) : null;
    let cached = !!ocrResult;
    debug(cached ? `cache HIT` : `cache miss`);

    // Stage 4: OCR (if cache miss)
    if (!ocrResult) {
      debug(`ocr.recognize() begin`);
      const tOcr = nowMs();
      try {
        ocrResult = await this.ocr.recognize(image, effectiveOptions);
      } catch (cause) {
        throw cause instanceof PolyOCRError
          ? cause
          : new PolyOCRError('OCR_FAILED', 'OCR adapter failed', cause);
      }
      timings.ocr = nowMs() - tOcr;
      debug(`ocr.recognize() done (${timings.ocr.toFixed(0)}ms, ${ocrResult.regions.length} regions)`);
      if (this.cache) await this.cache.set(hash, ocrResult);
    }

    // Apply region filters to OCR output.
    const filteredRegions = filterRegions(ocrResult.regions, effectiveOptions);
    const filteredText =
      filteredRegions.length === ocrResult.regions.length
        ? ocrResult.text
        : filteredRegions.map((r) => r.text).join('\n').trim();

    // Stage 5: language detection
    const tLang = nowMs();
    const lang = await detectLanguage(filteredText, {
      ollamaUrl: this.config.ollamaUrl,
      model: this.config.translationModel,
      noLlmFallback: !this.availability?.translator
    });
    timings.langdetect = nowMs() - tLang;
    debug(`langdetect done (${timings.langdetect.toFixed(0)}ms lang=${lang.language ?? 'null'})`);

    // Stage 6: translation
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
    debug(`translate done (${timings.translate.toFixed(0)}ms ${translation ? 'translated' : translationError ?? 'skipped'})`);

    // Stage 7: inpainting — Phase 3 wired here.
    const inpaintedImage: ImageData | null = null;

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

  /**
   * Process a list of images in parallel up to `concurrency` slots. Returns
   * results in input order (regardless of completion order).
   */
  async processBatch(inputs: PolyOCRInput[], options: BatchOptions = {}): Promise<ProcessResult[]> {
    await this.ready();
    return this.batch.processBatch(inputs, options);
  }

  /**
   * Stream results as soon as each image finishes. Each yielded result
   * carries its source `index` so the caller can reorder.
   */
  async *stream(inputs: PolyOCRInput[], options: BatchOptions = {}): AsyncGenerator<ProcessResult> {
    await this.ready();
    yield* this.batch.stream(inputs, options);
  }

  /**
   * Build a `RegionReference` for the LLM-matching workflow.
   *
   * Pass a *cropped* image of the region you want to match in future frames
   * along with a human label. The vision LLM produces a description of the
   * crop; that description is what makes the reference robust to mild
   * rotation, lighting, and scale changes.
   *
   * Example — instrument readout drift tolerance:
   *
   *   const ref = await pocr.buildReference(crop, 'pressure-gauge');
   *   for (const frame of frames) {
   *     const bbox = await pocr.findRegion(frame, ref);
   *     if (bbox) {
   *       const result = await pocr.process(frame, { regions: [bbox] });
   *       // result.text is the gauge reading
   *     }
   *   }
   */
  async buildReference(crop: PolyOCRInput, label: string): Promise<RegionReference> {
    await this.ready();
    if (!this.availability?.llm) {
      throw new PolyOCRError(
        'DETECT_UNAVAILABLE',
        'buildReference requires the LLM region detector. Ensure Ollama is running with a vision model (e.g. `ollama pull llama3.2-vision`).'
      );
    }
    const cropImage = await normalize(crop);
    const description = await this.describeCrop(cropImage, label);
    return {
      label,
      crop: cropImage,
      bbox: { x: 0, y: 0, w: cropImage.width, h: cropImage.height },
      description
    };
  }

  /**
   * Locate a previously-built `RegionReference` in a new image. Delegates
   * to the LLM detector's `findSimilar`.
   *
   * Example — see `buildReference()` JSDoc.
   *
   * Returns `null` if the LLM cannot find a confident match.
   */
  async findRegion(image: PolyOCRInput, reference: RegionReference): Promise<BoundingBox | null> {
    await this.ready();
    if (!this.availability?.llm) {
      throw new PolyOCRError(
        'DETECT_UNAVAILABLE',
        'findRegion requires the LLM region detector. Ensure Ollama is running with a vision model.'
      );
    }
    const target = await normalize(image);
    return await this.llmDetector.findSimilar(target, reference);
  }

  // -- Phase 4 entry points -------------------------------------------------

  async export(_results: ProcessResult[], _options: ExportOptions): Promise<Blob | Buffer> {
    throw new PolyOCRError('EXPORT_FAILED', 'export is implemented in Phase 4');
  }

  renderToCanvas(_result: ProcessResult, _canvas: HTMLCanvasElement, _options?: RenderOptions): void {
    throw new PolyOCRError('INVALID_OPTIONS', 'renderToCanvas is implemented in Phase 4');
  }

  async dispose(): Promise<void> {
    if (this.ocr.dispose) await this.ocr.dispose();
  }

  /**
   * Ask the vision LLM to describe a cropped region. Used by
   * `buildReference`. Lives on the class (not the LLMDetector) so we can
   * keep the prompt tuned for *describing* (single-pass) rather than
   * *locating* (which is the LLMDetector's job).
   */
  private async describeCrop(image: ImageData, label: string): Promise<string> {
    const ollamaUrl = this.config.ollamaUrl ?? 'http://localhost:11434';
    const model = this.config.visionModel ?? 'llama3.2-vision';
    const b64 = await imageToBase64Png(image);
    const prompt = DESCRIBE_PROMPT.replace('__LABEL__', label);
    let res: Response;
    try {
      res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          images: [b64],
          stream: false,
          options: { temperature: 0.1 }
        })
      });
    } catch (cause) {
      throw new PolyOCRError('DETECT_FAILED', 'Failed to reach Ollama for describeCrop', cause);
    }
    if (!res.ok) {
      throw new PolyOCRError('DETECT_FAILED', `Ollama responded ${res.status} to describeCrop`);
    }
    const json = (await res.json()) as { response?: string };
    return (json.response ?? '').trim();
  }
}

const DESCRIBE_PROMPT = `Describe the contents of this image in 1–2 sentences.

Context: this image is a crop labeled "__LABEL__". The description will be used to locate the same region in other images, so emphasize visual features (shape, colors, distinctive markings) over text content (text may be different in each frame).

Respond with the description only. No prose, no preamble, no markdown.`;

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

function mergeRegions(a: BoundingBox[] | undefined, b: BoundingBox[]): BoundingBox[] {
  if (!a || a.length === 0) return b;
  if (b.length === 0) return a;
  return [...a, ...b];
}

function bboxOverlaps(a: BoundingBox, b: BoundingBox): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

async function imageToBase64Png(image: ImageData): Promise<string> {
  if (typeof OffscreenCanvas !== 'undefined' && typeof Blob !== 'undefined') {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get OffscreenCanvas 2D context');
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  }
  const canvasMod = await import('@napi-rs/canvas');
  const c = canvasMod.createCanvas(image.width, image.height);
  const ctx = c.getContext('2d');
  const napiImageData = ctx.createImageData(image.width, image.height);
  napiImageData.data.set(image.data);
  ctx.putImageData(napiImageData, 0, 0);
  const buf = await c.encode('png');
  return Buffer.from(buf).toString('base64');
}
