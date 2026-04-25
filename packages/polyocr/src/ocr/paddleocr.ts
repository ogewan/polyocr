/**
 * Optional OCR adapter — PaddleOCR via a spawned Python FastAPI server.
 *
 * PaddleOCR is significantly better than Tesseract on:
 *   - CJK scripts (Chinese, Japanese, Korean)
 *   - Dense, structured layouts (newspapers, tables, receipts)
 *   - Mixed-script content
 *
 * It has no usable JavaScript port, so the bridge is a small Python FastAPI
 * server (`bridge/paddleocr_server.py`) that this adapter spawns and manages.
 *
 * Lifecycle:
 *   1. `isAvailable()`: Python on PATH? `import paddleocr` succeeds?
 *   2. First `recognize()` call: pick a free port → spawn uvicorn → poll `/health`
 *      with exponential backoff (50ms → 100ms → 200ms → ... → 5s, max 30s total).
 *   3. Subsequent calls: HTTP POST `/recognize` with base64 image bytes.
 *   4. `dispose()` sends SIGTERM, waits, escalates to SIGKILL after 5s.
 *
 * Why HTTP (not stdin/stdout pipes):
 *   - Backpressure is easier with HTTP (the FastAPI server natively queues).
 *   - Errors are structured (HTTP status codes) instead of having to parse stderr.
 *   - The server is debuggable independently — you can curl `/recognize` to
 *     isolate whether a problem is in the bridge or in PaddleOCR itself.
 *
 * Phase 3 implements this in full.
 */
export {};
