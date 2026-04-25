/**
 * Vision-LLM region detector.
 *
 * `detect(image)`: encodes the image to base64 PNG, sends a multimodal prompt
 * to Ollama (`llama3.2-vision` or `moondream2`) asking for a JSON array of
 * bounding boxes with descriptions. The LLM is much slower than OpenCV
 * (1–10 seconds vs. ~50ms) but handles unstructured / complex images far
 * better.
 *
 * `findSimilar(image, reference)`: this is the workhorse for the
 * instrument-readout / drift-tolerance use case. We build the prompt from
 * `reference.description` (text), `reference.label` (text), and the full
 * target image, asking the LLM to locate the same region. The LLM returns
 * a single bbox or `null` if it can't find a confident match.
 *
 * Prompt strings are kept as named constants at the top of the module so
 * they're easy to tune without hunting through string concatenation. Each
 * prompt phrase has a comment explaining why it's there:
 *   - "Return ONLY a JSON array, no prose" — vision LLMs love to add commentary.
 *   - "If you cannot find the region, return null" — without this they
 *     hallucinate bboxes for absent regions.
 *   - "Coordinates are in image pixels, top-left origin" — without this
 *     the LLM wavers between normalized [0,1] and pixel coordinates.
 *
 * JSON parse failures are handled gracefully: we strip code fences, find
 * the first `{` or `[`, and try `JSON.parse` on the slice. On total parse
 * failure we return `[]` from `detect` and `null` from `findSimilar`
 * rather than throwing.
 */

import type {
  RegionDetector,
  DetectOptions,
  RegionReference,
  BoundingBox
} from '../types.js';

interface LLMDetectorConfig {
  ollamaUrl?: string;
  /** Vision model name. Default `'llama3.2-vision'`. `'moondream2'` is the lightweight alternative. */
  model?: string;
}

export class LLMDetector implements RegionDetector {
  public readonly name = 'llm';
  private readonly ollamaUrl: string;
  private readonly model: string;

  constructor(config: LLMDetectorConfig = {}) {
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'llama3.2-vision';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!res.ok) return false;
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      const models = json.models ?? [];
      const family = this.model.split(':')[0];
      return models.some((m) => m.name === this.model || m.name.startsWith(family));
    } catch {
      return false;
    }
  }

  async detect(image: ImageData, options: DetectOptions = {}): Promise<BoundingBox[]> {
    const b64 = await imageDataToBase64Png(image);
    const prompt = DETECT_PROMPT
      .replace('__W__', String(image.width))
      .replace('__H__', String(image.height))
      .replace('__LIMIT__', options.limit ? `Return at most ${options.limit} regions.` : '');
    const raw = await this.runOllama(prompt, b64);
    const parsed = parseRegionList(raw);
    return parsed
      .filter((b) => isValidBbox(b, image.width, image.height))
      .filter((b) => isValidArea(b, options));
  }

  async findSimilar(image: ImageData, reference: RegionReference): Promise<BoundingBox | null> {
    const b64 = await imageDataToBase64Png(image);
    const prompt = FIND_SIMILAR_PROMPT
      .replace('__LABEL__', reference.label)
      .replace('__DESC__', reference.description)
      .replace('__W__', String(image.width))
      .replace('__H__', String(image.height));
    const raw = await this.runOllama(prompt, b64);
    const parsed = parseSingleRegion(raw);
    if (!parsed) return null;
    return isValidBbox(parsed, image.width, image.height) ? parsed : null;
  }

  private async runOllama(prompt: string, imageB64: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          images: [imageB64],
          stream: false,
          // Low temperature keeps the bbox numbers stable across runs. Vision
          // models otherwise return slightly different coordinates for the
          // same input on repeated calls.
          options: { temperature: 0.1 }
        })
      });
    } catch {
      return '';
    }
    if (!res.ok) return '';
    const json = (await res.json()) as { response?: string };
    return json.response ?? '';
  }
}

// -- Prompts --------------------------------------------------------------

const DETECT_PROMPT = `You are a region detector.

Identify all distinct regions of text in this image. For each region, return its bounding box.

Image dimensions: __W__ x __H__ pixels.

__LIMIT__

Return ONLY a JSON array of objects:
[
  {"x": <int>, "y": <int>, "w": <int>, "h": <int>, "description": "<short description>"},
  ...
]

Coordinates are in image pixels, top-left origin. If no text regions are present, return [].
Do not include any prose, commentary, or markdown fences.`;

const FIND_SIMILAR_PROMPT = `You are a region matcher.

A reference region was previously identified with these properties:
- Label: __LABEL__
- Description: __DESC__

Locate the same region in this image. The image dimensions are __W__ x __H__ pixels.

Return ONLY a JSON object:
{"x": <int>, "y": <int>, "w": <int>, "h": <int>}

Coordinates are in image pixels, top-left origin.

If you cannot find the region with confidence, return {"x": null}.

Do not include any prose, commentary, or markdown fences.`;

// -- Parsers --------------------------------------------------------------

function parseRegionList(raw: string): BoundingBox[] {
  const json = extractJsonSlice(raw, '[', ']');
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Array<{ x?: number; y?: number; w?: number; h?: number }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((o) => typeof o.x === 'number' && typeof o.y === 'number' && typeof o.w === 'number' && typeof o.h === 'number')
      .map((o) => ({ x: o.x!, y: o.y!, w: o.w!, h: o.h! }));
  } catch {
    return [];
  }
}

function parseSingleRegion(raw: string): BoundingBox | null {
  const json = extractJsonSlice(raw, '{', '}');
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as { x?: number | null; y?: number; w?: number; h?: number };
    if (obj.x === null || obj.x === undefined) return null;
    if (typeof obj.x !== 'number' || typeof obj.y !== 'number' || typeof obj.w !== 'number' || typeof obj.h !== 'number') {
      return null;
    }
    return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
  } catch {
    return null;
  }
}

/**
 * Find the first balanced JSON slice starting with `open` and ending with
 * `close`. Tolerates LLMs adding code fences or prose around the JSON.
 */
function extractJsonSlice(raw: string, open: string, close: string): string | null {
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function isValidBbox(b: BoundingBox, w: number, h: number): boolean {
  if (b.w <= 0 || b.h <= 0) return false;
  if (b.x < 0 || b.y < 0) return false;
  if (b.x + b.w > w || b.y + b.h > h) return false;
  return true;
}

function isValidArea(b: BoundingBox, opts: DetectOptions): boolean {
  if (opts.minArea && b.w * b.h < opts.minArea) return false;
  return true;
}

// -- Image encoding ------------------------------------------------------

async function imageDataToBase64Png(image: ImageData): Promise<string> {
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
  // Node fallback via @napi-rs/canvas
  const canvasMod = await import('@napi-rs/canvas');
  const c = canvasMod.createCanvas(image.width, image.height);
  const ctx = c.getContext('2d');
  const napiImageData = ctx.createImageData(image.width, image.height);
  napiImageData.data.set(image.data);
  ctx.putImageData(napiImageData, 0, 0);
  const buf = await c.encode('png');
  return Buffer.from(buf).toString('base64');
}
