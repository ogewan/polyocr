/**
 * Example: process a directory of images in parallel and print a summary.
 *
 * Run with:
 *   npx tsx examples/batch.ts ./samples
 *   LANGS=eng,jpn npx tsx examples/batch.ts ./samples
 *
 * What it demonstrates:
 *   - `pocr.processBatch(inputs, { concurrency, ... })` parallel execution.
 *   - Stable result ordering by `result.index` even when fast images
 *     finish before slower ones started earlier.
 *   - Per-image timings.
 */

import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PolyOCR } from '../src/index.js';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: npx tsx examples/batch.ts <directory>');
  process.exit(1);
}

const langs = (process.env.LANGS ?? 'eng').split(',').map((s) => s.trim()).filter(Boolean);

const files = readdirSync(dir)
  .filter((f) => /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(extname(f)))
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`No images found in ${dir}`);
  process.exit(1);
}

const pocr = new PolyOCR({
  tesseractLanguages: langs,
  workerCount: 2,
  verbose: true
});

await pocr.ready();

console.log(`Processing ${files.length} images with concurrency=2 ...`);
const t0 = performance.now();
const results = await pocr.processBatch(files, { concurrency: 2 });
const elapsed = performance.now() - t0;

console.log(`---`);
console.log(`Done in ${(elapsed / 1000).toFixed(1)}s total`);
for (const r of results) {
  const snippet = r.text.slice(0, 60).replace(/\s+/g, ' ');
  console.log(
    `[${r.index}] ${r.language ?? 'und'}  ${r.regions.length}r  ${r.durationMs.toFixed(0)}ms  ${r.cached ? '(cached)' : '       '}  ${snippet}${r.text.length > 60 ? '…' : ''}`
  );
}

await pocr.dispose();
