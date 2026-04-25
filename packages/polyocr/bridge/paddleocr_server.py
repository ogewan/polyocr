"""
PaddleOCR FastAPI bridge server.

Spawned on demand by `src/ocr/paddleocr.ts` when the user selects PaddleOCR as
their OCR adapter. Communicates over HTTP on a randomly-assigned local port.

Endpoints
---------
GET  /health
    Returns {"status": "ok"} once PaddleOCR has finished loading. Used for
    startup probing with exponential backoff from the Node side.

POST /recognize
    Body: { "image_b64": "<base64 PNG/JPEG>", "options": { ... } }
    Returns OcrResult JSON matching the TypeScript shape:
        {
            "text": "<joined>",
            "regions": [
                { "text": "...", "bbox": {"x":..,"y":..,"w":..,"h":..}, "confidence": 0.97 },
                ...
            ],
            "confidence": <float | null>,
            "engine": "paddleocr"
        }

Why a separate server (vs. piped subprocess stdin/stdout):
    - HTTP gives us structured error codes (5xx for bridge bugs, 4xx for bad
      input) instead of having to invent our own framing protocol.
    - FastAPI/uvicorn handles concurrent requests natively, which matters once
      the user fires a batch with concurrency > 1.
    - The server can be debugged independently — `curl http://localhost:PORT/health`
      isolates whether a problem lives in the bridge or in PaddleOCR itself.

Phase 3 implements this in full.
"""
