/**
 * Formal OCR adapter interface.
 *
 * The PolyOCR pipeline calls `OcrAdapter.recognize()` once per image. The adapter is
 * responsible for actually running an OCR engine (Tesseract, PaddleOCR, a hosted
 * service, etc.) and returning a structured `OcrResult` with per-region bounding
 * boxes and per-region confidence scores.
 *
 * # When to implement this interface
 * Implement a custom adapter when you need:
 *   - A hosted OCR service (Google Vision, AWS Textract, etc.) that hits an HTTP API.
 *   - A specialized model (handwriting recognition, table detection) that the bundled
 *     adapters don't cover.
 *   - Logic that wraps Tesseract / PaddleOCR with extra preprocessing (deskew,
 *     denoise, contrast normalization) you want applied universally.
 *
 * # What `isAvailable()` is expected to do
 * It is NOT enough to `return true`. The probe must actually verify that the OCR
 * engine can run in the current environment:
 *   - Network adapters: ping the API base URL or `HEAD /health`.
 *   - Subprocess adapters (PaddleOCR): check the runtime is on PATH AND that the
 *     required Python packages import without error.
 *   - WASM adapters (Tesseract): confirm the WASM module loaded successfully.
 *
 * `PolyOCR`'s constructor calls `isAvailable()` on every adapter and logs a warning
 * for any that fail — so a wrong probe causes silent runtime failures later.
 *
 * # Error handling
 * `recognize()` must NOT throw for normal failure modes (engine crash, bad input,
 * timeout). It should return an `OcrResult` with `text: ''`, `regions: []`, and
 * (optionally) a low `confidence` so the caller can detect the failure without an
 * exception unwinding the whole pipeline. Truly fatal conditions (the adapter
 * itself is misconfigured) may throw `PolyOCRError`.
 */
export type { OcrAdapter, OcrResult, OcrOptions, RecognizedRegion, BoundingBox } from '../types.js';
