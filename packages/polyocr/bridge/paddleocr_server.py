"""
PaddleOCR FastAPI bridge server.

Spawned on demand by `src/ocr/paddleocr.ts` when the user selects PaddleOCR
as their OCR adapter. Communicates over HTTP on a randomly-assigned local
port supplied via the POLYOCR_PORT environment variable.

Endpoints
---------
GET  /health
    Returns {"status": "ok", "ready": <bool>}. Used for startup probing
    with exponential backoff from the Node side.

POST /recognize
    Body: { "image_b64": "<base64 PNG/JPEG>", "lang": "<lang>" }
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

Why a separate HTTP server (vs. a piped subprocess on stdin/stdout):
    - HTTP gives us structured error codes (5xx for bridge bugs, 4xx for
      bad input) instead of inventing our own framing protocol.
    - FastAPI/uvicorn handles concurrent requests natively, which matters
      once the user fires a batch with concurrency > 1.
    - The server can be debugged independently —
      `curl http://localhost:PORT/health` isolates whether a problem lives
      in the bridge or in PaddleOCR itself.

Run standalone for testing:
    POLYOCR_PORT=8765 uvicorn paddleocr_server:app --port 8765

Dependencies (install in a virtualenv):
    pip install fastapi uvicorn paddleocr pillow
"""

from __future__ import annotations

import base64
import io
import os
import sys
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="polyocr PaddleOCR bridge", version="0.1.0")

# PaddleOCR's first-call init is slow (~3-5s loading models). We do it lazily
# so /health can respond quickly while models are still loading; `ready`
# reflects whether the engine is initialized.
_engine: Any = None
_engine_lang: str | None = None
_init_error: str | None = None


def _ensure_engine(lang: str = "en") -> Any:
    """Lazily construct or re-init the PaddleOCR engine for the requested language."""
    global _engine, _engine_lang, _init_error
    if _engine is not None and _engine_lang == lang:
        return _engine
    try:
        from paddleocr import PaddleOCR  # imported here so the import cost
                                         # is paid once, on first request

        # use_angle_cls=True enables the textline orientation classifier so
        # rotated text is correctly OCRed. show_log=False silences the
        # noisy paddle banner that otherwise pollutes our stdout.
        _engine = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
        _engine_lang = lang
        _init_error = None
        return _engine
    except Exception as e:  # noqa: BLE001
        _init_error = f"{type(e).__name__}: {e}"
        raise


@app.get("/health")
def health() -> JSONResponse:
    """Liveness probe. Returns immediately even if the engine is still loading."""
    return JSONResponse(
        {
            "status": "ok",
            "ready": _engine is not None,
            "lang": _engine_lang,
            "init_error": _init_error,
        }
    )


class RecognizeRequest(BaseModel):
    image_b64: str
    lang: str = "en"


@app.post("/recognize")
def recognize(req: RecognizeRequest) -> dict:
    """Run PaddleOCR over a base64-encoded image and return structured result."""
    try:
        engine = _ensure_engine(req.lang)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"engine init failed: {e}") from e

    try:
        raw_bytes = base64.b64decode(req.image_b64)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad base64: {e}") from e

    # PaddleOCR accepts a numpy array or a path. We hand it bytes via PIL →
    # numpy because the in-memory path avoids a tempfile.
    try:
        from PIL import Image
        import numpy as np  # PaddleOCR depends on numpy anyway

        pil = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
        arr = np.array(pil)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"image decode failed: {e}") from e

    try:
        # PaddleOCR returns a list-of-lists. Each inner element is
        # [bbox_4_corners, (text, confidence)]. We flatten to our schema.
        result = engine.ocr(arr, cls=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ocr failed: {e}") from e

    regions = []
    text_parts = []
    if result and result[0]:
        for line in result[0]:
            corners, (text, confidence) = line
            xs = [pt[0] for pt in corners]
            ys = [pt[1] for pt in corners]
            x0, y0 = min(xs), min(ys)
            x1, y1 = max(xs), max(ys)
            regions.append(
                {
                    "text": text,
                    "bbox": {
                        "x": int(round(x0)),
                        "y": int(round(y0)),
                        "w": int(round(x1 - x0)),
                        "h": int(round(y1 - y0)),
                    },
                    "confidence": float(confidence),
                }
            )
            text_parts.append(text)

    avg_conf = sum(r["confidence"] for r in regions) / len(regions) if regions else None
    return {
        "text": "\n".join(text_parts),
        "regions": regions,
        "confidence": avg_conf,
        "engine": "paddleocr",
    }


if __name__ == "__main__":
    # Convenience entry point so `python paddleocr_server.py 8765` works
    # without uvicorn on the CLI.
    import uvicorn  # noqa: WPS433

    port = int(os.environ.get("POLYOCR_PORT") or (sys.argv[1] if len(sys.argv) > 1 else "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
