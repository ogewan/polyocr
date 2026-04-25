/**
 * Optional OCR adapter — PaddleOCR via a spawned Python FastAPI server.
 *
 * PaddleOCR is significantly better than Tesseract on:
 *   - CJK scripts (Chinese, Japanese, Korean)
 *   - Dense, structured layouts (newspapers, tables, receipts)
 *   - Mixed-script content
 *
 * It has no usable JavaScript port, so this adapter spawns the bundled
 * Python FastAPI server (`bridge/paddleocr_server.py`) and talks to it
 * over HTTP on a random local port.
 *
 * Lifecycle:
 *   1. `isAvailable()`: Python on PATH? `import paddleocr` succeeds in a
 *      probe subprocess?
 *   2. First `recognize()` call: pick a free port → spawn
 *      `python paddleocr_server.py {port}` → poll `/health` with
 *      exponential backoff (50ms → 100ms → 200ms → ... up to 30s total).
 *   3. Subsequent calls: HTTP POST `/recognize` with base64 image bytes.
 *   4. `dispose()` sends SIGTERM, waits, escalates to SIGKILL after 5s.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type {
  OcrAdapter,
  OcrOptions,
  OcrResult,
  RecognizedRegion
} from '../types.js';
import { PolyOCRError } from '../types.js';

interface PaddleOCRConfig {
  /** Override the python executable. Default tries `python3` then `python`. */
  pythonPath?: string;
  /** Path to the bridge server script. Default: bundled `bridge/paddleocr_server.py`. */
  serverPath?: string;
  /** Default language. Default `'en'`. PaddleOCR codes: en, ch, japan, korean, ... */
  lang?: string;
  /** Override the port. Default: pick a free one at startup. */
  port?: number;
}

export class PaddleOCRAdapter implements OcrAdapter {
  public readonly name = 'paddleocr';
  private readonly pythonPath: string;
  private readonly serverPath: string;
  private readonly lang: string;
  private overridePort?: number;
  private port: number | null = null;
  private process: ChildProcess | null = null;
  private startupPromise: Promise<void> | null = null;

  constructor(config: PaddleOCRConfig = {}) {
    this.pythonPath = config.pythonPath ?? defaultPython();
    this.serverPath = config.serverPath ?? resolveDefaultServerPath();
    this.lang = config.lang ?? 'en';
    if (config.port !== undefined) this.overridePort = config.port;
  }

  async isAvailable(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const child = spawn(this.pythonPath, ['-c', 'import paddleocr; import fastapi; import uvicorn'], {
        stdio: 'ignore',
        timeout: 8000
      });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  async recognize(image: ImageData, _options: OcrOptions): Promise<OcrResult> {
    void _options;
    await this.start();
    if (this.port === null) {
      throw new PolyOCRError('OCR_FAILED', 'PaddleOCR bridge not running');
    }
    const b64 = await imageToBase64Png(image);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: b64, lang: this.lang })
      });
    } catch (cause) {
      throw new PolyOCRError('OCR_FAILED', 'PaddleOCR HTTP call failed', cause);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new PolyOCRError('OCR_FAILED', `PaddleOCR /recognize returned ${res.status}: ${detail}`);
    }
    const json = (await res.json()) as {
      text: string;
      regions: Array<{
        text: string;
        bbox: { x: number; y: number; w: number; h: number };
        confidence: number;
      }>;
      confidence?: number | null;
      engine: string;
    };
    const regions: RecognizedRegion[] = json.regions.map((r) => ({
      text: r.text,
      bbox: r.bbox,
      confidence: r.confidence
    }));
    const result: OcrResult = {
      text: json.text,
      regions,
      engine: 'paddleocr',
      ...(typeof json.confidence === 'number' ? { confidence: json.confidence } : {})
    };
    return result;
  }

  async dispose(): Promise<void> {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;
    this.port = null;
    this.startupPromise = null;
    proc.kill('SIGTERM');
    // Escalate to SIGKILL after 5s if the process didn't exit gracefully.
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 5000);
    await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    clearTimeout(killTimer);
  }

  private async start(): Promise<void> {
    if (this.process && this.port !== null) return;
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = (async () => {
      const port = this.overridePort ?? (await pickFreePort());
      this.port = port;
      const env = { ...process.env, POLYOCR_PORT: String(port) };
      const proc = spawn(this.pythonPath, [this.serverPath, String(port)], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.process = proc;
      // Drain server output to our stderr only when verbose, otherwise
      // ignore — the bridge logs are noisy.
      const verbose = process.env.POLYOCR_VERBOSE === '1';
      proc.stdout?.on('data', (b) => {
        if (verbose) process.stderr.write(`[paddleocr-bridge] ${b}`);
      });
      proc.stderr?.on('data', (b) => {
        if (verbose) process.stderr.write(`[paddleocr-bridge] ${b}`);
      });
      proc.on('exit', (code) => {
        if (verbose) console.error(`[paddleocr-bridge] process exited with code ${code}`);
        this.process = null;
        this.port = null;
        this.startupPromise = null;
      });

      // Poll /health with exponential backoff up to 30s. Models load on
      // first /recognize, not at /health, so we just need the HTTP server
      // to be listening.
      const deadline = Date.now() + 30000;
      let delay = 50;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(2000)
          });
          if (res.ok) return;
        } catch {
          // not yet listening; back off
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 2000);
      }
      // Failed to start within deadline — kill and report.
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      throw new PolyOCRError('BRIDGE_SPAWN_FAILED', `PaddleOCR bridge did not start within 30s on port ${port}`);
    })();
    try {
      await this.startupPromise;
    } catch (err) {
      this.startupPromise = null;
      throw err;
    }
  }
}

function defaultPython(): string {
  // We can't probe at module-load time. Trust PATH; the user can override
  // via `pythonPath` in config.
  return process.platform === 'win32' ? 'python' : 'python3';
}

function resolveDefaultServerPath(): string {
  // The compiled package layout puts `bridge/` next to the `dist/` it
  // emits. During dev (running from src/) the bridge is two levels up.
  // We resolve relative to this file's URL — works in both cases.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', 'bridge', 'paddleocr_server.py');
  } catch {
    // CJS fallback: __dirname is set by the bundler.
    return resolve(__dirname, '..', '..', 'bridge', 'paddleocr_server.py');
  }
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolveFn, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        const port = (addr as any).port as number;
        srv.close(() => resolveFn(port));
      } else {
        srv.close();
        reject(new Error('Could not get free port'));
      }
    });
  });
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
  const napi = ctx.createImageData(image.width, image.height);
  napi.data.set(image.data);
  ctx.putImageData(napi, 0, 0);
  const buf = await c.encode('png');
  return Buffer.from(buf).toString('base64');
}
