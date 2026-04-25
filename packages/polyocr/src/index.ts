/**
 * Public entry point for the polyocr package.
 *
 * Re-exports the `PolyOCR` class, every type from `types.ts`, and the formal
 * adapter interfaces. Consumers should import from `'polyocr'` — the deeper
 * paths (`'polyocr/adapters'`, etc.) are exposed for advanced use.
 */

export { PolyOCR } from './PolyOCR.js';
export { PolyOCRError } from './types.js';
export type {
  PolyOCRInput,
  PolyOCRConfig,
  PolyOCRErrorCode,
  OcrAdapter,
  OcrOptions,
  OcrResult,
  RecognizedRegion,
  RegionDetector,
  DetectOptions,
  RegionReference,
  TranslationAdapter,
  CacheProvider,
  BoundingBox,
  MaskRegion,
  ProcessResult,
  ProcessTimings,
  OutputSpec,
  BatchOptions,
  ExportOptions,
  RenderOptions,
  InpaintMode,
  FontConfig
} from './types.js';

// Convenience re-exports for the common adapters.
export { TesseractAdapter } from './ocr/tesseract.js';
export { PaddleOCRAdapter } from './ocr/paddleocr.js';
export { OllamaTranslationAdapter } from './translate/ollama.js';
export { OpenCVDetector } from './detect/opencv.js';
export { LLMDetector } from './detect/llm.js';
export { MemoryCache, hashImageData } from './cache.js';
export { detectLanguage, detectFromImage } from './langdetect.js';
export { normalize, extractChromaMask } from './ingest.js';
export { BatchProcessor } from './batch.js';
export { inpaint } from './inpaint.js';
