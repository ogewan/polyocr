/**
 * Secondary entry point exposing all adapter implementations.
 *
 * Imported as `import { TesseractAdapter, OllamaTranslationAdapter } from 'polyocr/adapters'`.
 * Useful when a consumer wants to instantiate adapters explicitly (e.g. to share
 * one OCR adapter across multiple `PolyOCR` instances) instead of letting the
 * default constructor wire them up.
 *
 * Phase 1 ships Tesseract + Ollama. Phase 2 adds OpenCV + LLM region detectors.
 * Phase 3 adds PaddleOCR. Phase 6 adds DeepL + LibreTranslate.
 */

export { TesseractAdapter } from './ocr/tesseract.js';
export { OllamaTranslationAdapter } from './translate/ollama.js';
export { OpenCVDetector } from './detect/opencv.js';
export { LLMDetector } from './detect/llm.js';
