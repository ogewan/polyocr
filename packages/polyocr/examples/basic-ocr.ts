/**
 * Example: process a single image file and print the recognized text.
 *
 * Run with:
 *   npx tsx examples/basic-ocr.ts ./path/to/image.png
 *
 * What it demonstrates:
 *   - Constructing a `PolyOCR` with default config (Tesseract + Ollama).
 *   - Single-image `process()` with no translation requested.
 *   - Awaiting `pocr.ready()` to validate adapter availability before the
 *     first call (so adapter probe failures show up cleanly at startup).
 */

import { PolyOCR } from '../src/index.js';

const path = process.argv[2];
if (!path) {
  console.error('Usage: npx tsx examples/basic-ocr.ts <image-file>');
  process.exit(1);
}

// Languages can be passed via env: LANGS=eng,jpn npx tsx examples/basic-ocr.ts ./img.png
const langs = (process.env.LANGS ?? 'eng').split(',').map((s) => s.trim()).filter(Boolean);

const pocr = new PolyOCR({
  // English-only Tesseract is fastest. Add more languages if your image is
  // multilingual:  tesseractLanguages: ['eng', 'jpn', 'chi_sim']
  tesseractLanguages: langs,
  workerCount: 1,
  verbose: true
});

await pocr.ready();

const result = await pocr.process(path);

console.log('---');
console.log('Detected language:', result.language, `(confidence ${result.languageConfidence.toFixed(2)})`);
console.log('Recognized text:');
console.log(result.text);
console.log('---');
console.log(`Regions: ${result.regions.length}`);
console.log(`Cached: ${result.cached}`);
console.log(`Duration: ${result.durationMs.toFixed(0)}ms`);

await pocr.dispose();
