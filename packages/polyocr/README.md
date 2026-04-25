# polyocr

Headless multilingual OCR pipeline. Reads images, extracts text in any of ~100 supported scripts, detects language, optionally translates the result, optionally inpaints the original text and renders the translation back into the image, and exports to JSON / CSV / SRT / VTT / ZIP.

Built around three swappable adapter interfaces — `OcrAdapter`, `RegionDetector`, `TranslationAdapter` — so any stage can be replaced without touching the others.

## Install

```bash
npm install polyocr
```

The package targets Node 20+ and modern browsers (via WASM). `tesseract.js`, `franc`, `jszip`, and `better-sqlite3` are direct dependencies. `canvas` is an *optional* dependency used to polyfill `OffscreenCanvas` when running in a Node main process; in browsers / workers it isn't needed.

## Quickstart

```ts
import { PolyOCR } from 'polyocr';

const pocr = new PolyOCR({
  ollamaUrl: 'http://localhost:11434',
  workerCount: 2,
});

// Recognize text in any image
const result = await pocr.process('./scan.png');
console.log(result.text);
console.log(result.language, result.languageConfidence);

// Translate to English
const translated = await pocr.process('./scan.png', { translate: 'en' });
console.log(translated.translation);
```

## Accepted input types

The ingest module normalizes everything to `ImageData`:

| Input | Notes |
|---|---|
| `File` | Browser file picker / drag-drop |
| `Blob` | Goes through `createImageBitmap` → canvas → `getImageData` |
| `HTMLImageElement` | Must be loaded; uses naturalWidth/Height |
| `HTMLCanvasElement` | Direct `getContext('2d').getImageData` |
| `OffscreenCanvas` | Direct |
| `ImageData` | Pass-through |
| `ArrayBuffer` | Wrapped in a `Blob` then decoded |
| `string` (path) | Filesystem (Node only) |
| `string` (data URL) | Decoded via `fetch(dataUrl)` → blob |
| `string` (base64) | Decoded directly |

## `pocr.process(input, options?)`

Single-image pipeline. Returns `Promise<ProcessResult>`.

```ts
const result = await pocr.process(input, {
  // Region constraints
  regions: [{ x: 100, y: 50, w: 400, h: 80 }], // OCR only inside these
  excludeRegions: [/* ... */],                  // Discard recognized regions overlapping these
  autoDetect: true,                             // Run OpenCV contour detector first
  detectWithLLM: true,                          // Run vision LLM detector first

  // Translation
  translate: 'en',                              // Target ISO code; null/omit to skip
  translationDomain: 'manga',                   // 'neutral' | 'manga' | 'technical' | 'formal'

  // Inpainting (Phase 3+)
  inpaint: 'fill',                              // 'chroma' | 'blur' | 'fill' | 'clone'
  chromaKey: '#FF00FF',                         // For 'chroma' mode
  chromaTolerance: 16,
  font: { family: 'Noto Sans', color: '#000' },

  // Output requests
  output: {
    text: true,        // (default) populate result.text
    regions: true,     // (default) populate result.regions
    image: true,       // populate result.inpaintedImage (only meaningful with `inpaint`)
    canvas: someHTMLCanvasElement, // also draw result onto this canvas
  },
});
```

`ProcessResult`:

```ts
{
  index: number,                    // Stable across batch / stream
  text: string,                     // Joined OCR output
  language: string | null,          // ISO 639-3 from franc, or null for numerals-only
  languageConfidence: number,
  regions: RecognizedRegion[],      // Per-region text + bbox + confidence
  translation: string | null,
  translationError: string | null,
  inpaintedImage: ImageData | null,
  cached: boolean,
  durationMs: number,
}
```

## `pocr.processBatch(inputs, options?)` and `pocr.stream(inputs, options?)`

Batch returns `Promise<ProcessResult[]>` in input order. Stream returns an `AsyncIterable<ProcessResult>` that yields as soon as each item finishes — useful for driving a progress bar or piping to a UI.

`BatchOptions` extends single-image options with `concurrency`, `fps` (for SRT/VTT exports), and `cache: CacheProvider | false`.

## `pocr.export(results, options)`

Serializes `ProcessResult[]` into one of:

- `'json'` — straight `JSON.stringify` with `inpaintedImage` re-encoded as a data URL
- `'txt'` — newline-joined translated (or original if no translation) text
- `'csv'` — configurable columns, configurable delimiter, RFC-4180 quoting
- `'srt'` — subtitle blocks, timestamps from `result.index` and `BatchOptions.fps`
- `'vtt'` — same as SRT, WebVTT format with millisecond precision
- `'zip'` — bundles selected content (images + csv + json + txt) with optional manifest

```ts
const blob = await pocr.export(results, {
  format: 'zip',
  zip: { include: ['images', 'csv', 'json'], imageFormat: 'webp', manifest: true }
});
```

In the Node main process this returns a `Buffer`; in a browser / Electron renderer a `Blob`.

## `pocr.renderToCanvas(result, canvas, options?)`

Three modes:

- `'inpainted'` — draws `result.inpaintedImage` (run `process()` with `inpaint` first)
- `'overlay'` — draws the original image, then overlays the translated text at each region's bbox without filling
- `'bboxes-only'` — draws the original image with colored bbox outlines and labels (debugging)

## CLI

```bash
# Single image, OCR only, JSON to stdout
polyocr process page.png

# OCR + translate, write CSV
polyocr process page.png --translate en --output result.csv --format csv

# Batch a directory of frames into an SRT
polyocr batch ./frames --translate en --format srt --fps 24 --output movie.srt

# Constrain to an ROI
polyocr detect page.png --roi "100,50,400,80" --translate en

# Instrument readout: build a reference once, run a batch with positional drift tolerance
polyocr batch ./gauges --ref ./gauges/ref.jpg --translate en --output csv --format csv
```

`--include` selects which content goes into a ZIP export (`images,csv,json,txt`). Progress prints to stderr so stdout stays clean for piping JSON.

## Adapter system

The three core stages are abstract:

```ts
interface OcrAdapter {
  name: string;
  recognize(image: ImageData, options: OcrOptions): Promise<OcrResult>;
  isAvailable(): Promise<boolean>;
}

interface RegionDetector {
  name: string;
  detect(image: ImageData, options?: DetectOptions): Promise<BoundingBox[]>;
  findSimilar(image: ImageData, reference: RegionReference): Promise<BoundingBox | null>;
  isAvailable(): Promise<boolean>;
}

interface TranslationAdapter {
  name: string;
  translate(text: string, from: string, to: string): Promise<string>;
  supportedLanguages(): string[];
  isAvailable(): Promise<boolean>;
}
```

`isAvailable()` is required to *probe* its dependency — for the PaddleOCR adapter that means checking that Python is on PATH and `paddleocr` imports successfully; for the Ollama translation adapter it means hitting `/api/tags` and confirming the configured model is pulled. A constructor that runs `Promise.all` over `isAvailable()` and logs warnings for unavailable optional adapters is the right shape — the user shouldn't have to discover at runtime that their MTL engine isn't reachable.

To plug in your own adapter:

```ts
import { PolyOCR, OcrAdapter, OcrResult } from 'polyocr';

class MyOcr implements OcrAdapter {
  name = 'my-ocr';
  async isAvailable() { /* probe */ return true; }
  async recognize(image: ImageData, options): Promise<OcrResult> { /* ... */ }
}

const pocr = new PolyOCR({ ocrAdapter: new MyOcr() });
```

## LLM region matching — the instrument readout workflow

The premise: you have hundreds of photos of an analog dial whose position drifts a few dozen pixels frame-to-frame because the camera or the rig isn't perfectly fixed. A static `BoundingBox` won't work — you need *positional drift tolerance*.

**Step 1.** From a single representative frame, build a `RegionReference`:

```ts
const ref = await pocr.buildReference(crop, 'pressure-gauge');
// ref = { label, crop, bbox, description: '<llama3.2-vision describes the dial>' }
```

The vision LLM produces a natural-language description of the cropped region. That description is what makes the reference robust to translation, rotation, and lighting changes.

**Step 2.** For each frame, find the matching region:

```ts
const bbox = await pocr.findRegion(image, ref);
// bbox = the dial's location in this frame, or null if not found
```

**Step 3.** Run the batch with `regions: [bbox]` so OCR only reads the dial:

```ts
const results = await pocr.processBatch(frames, {
  regions: [bbox],   // (you'd typically build this list per-frame via findRegion)
  translate: false   // numerals-only suppresses translation anyway
});
```

The CLI variant (`--ref`) folds steps 1–3 together: it loads the representative image, builds the reference, then for each batch input calls `findRegion` and applies the result as the per-frame ROI before OCR.

## Inpainting pipeline

Four modes, three of which are wired:

| Mode | What it does |
|---|---|
| `'chroma'` | Caller supplies a `#FF00FF`-keyed mask. Each masked region gets fill + translated text rendered over it. |
| `'blur'` | Gaussian blur (default σ=8) over each OCR bbox. No text rendering — just obfuscation. |
| `'fill'` | Sample bbox perimeter pixels → take median color → flood the bbox interior with that color → render translated text using `Noto Sans` with binary-search size fitting to the bbox at 4px padding. |
| `'clone'` | **Stub.** Content-aware fill (PatchMatch / frequency-domain inpainting) is deferred to v2 because a quality implementation is a project unto itself. The stub logs a warning and returns the input unchanged. |

The font renderer is intentionally simple: there is no layout engine, so line-breaking and font-size selection are computed manually with `ctx.measureText`. The binary search picks the largest size where the wrapped lines fit vertically within the bbox at 4px padding. That gives consistent visual density across regions of widely varying size — a single fixed font size would either overflow small bubbles or look tiny in large ones.

## PaddleOCR bridge

Tesseract is the default because it's pure WASM and works everywhere with no setup. PaddleOCR is *much* better for CJK and dense / structured layouts, but it has no JavaScript port worth using. The bridge is a small Python FastAPI server that the package can spawn on demand:

1. `PaddleOCRAdapter.isAvailable()` checks: Python on PATH → can `import paddleocr`.
2. On first `recognize()` call: pick a free port → spawn `uvicorn paddleocr_server:app --port {port}` → poll `/health` with exponential backoff.
3. `recognize()` POSTs base64 image bytes; the server returns JSON matching `OcrResult`.
4. The subprocess is reused across calls and torn down on `pocr.dispose()`.

Use PaddleOCR when:
- Your input is Chinese, Japanese, Korean, or has heavy mixed-script content.
- Your layout is dense (newspapers, tables, receipts).
- You're running in Node and can afford a Python install.

Use Tesseract when:
- You need to run in a browser.
- Your input is primarily Latin script.
- You need zero-dependency portability.

## Language detection — two tiers

**Tier 1: `franc`.** A statistical n-gram detector. Fast, deterministic, no model. Works well on text ≥ 30 characters in clean script. We accept its result if confidence ≥ 0.7.

**Tier 2: Ollama.** For text shorter than 30 chars, mixed-script, or low-confidence franc output we send a structured prompt to `aya:8b` asking for `{ language, confidence, script }` JSON. The vision LLM (`llama3.2-vision`) is also available for the rare case where the OCR text is too noisy to detect from at all and the LLM can read the image directly.

A special case: **numerals-only output** (e.g. `123.45`, `2024-01-15`, `42°C`) returns `language: null` and translation is suppressed entirely. There's no language to detect and translating numbers produces hallucinations.

## Ollama setup

The package assumes an Ollama instance reachable at the configured URL (default `http://localhost:11434`). Install Ollama, then pull the models you want:

```bash
# Translation (recommended — 23 languages, instruction-tuned)
ollama pull aya:8b              # ~5 GB VRAM

# Vision LLM for region detection
ollama pull llama3.2-vision     # ~8 GB VRAM
ollama pull moondream2          # ~2 GB VRAM (lightweight fallback)

# Lighter MTL fallback if aya:8b is too heavy
ollama pull llama3.2:3b         # ~2 GB VRAM
```

If Ollama isn't running, every adapter that depends on it fails its `isAvailable()` probe. The pipeline still works — language detection falls back to franc-only, translation is skipped (with `translationError: 'ollama unavailable'` on the result), region detection falls back to OpenCV. Nothing throws.

VRAM guidance: `aya:8b` + `llama3.2-vision` together need ~13 GB; on a 12 GB card, expect them to swap. On an 8 GB card use `llama3.2:3b` + `moondream2` instead.
