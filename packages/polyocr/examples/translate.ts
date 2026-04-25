/**
 * Example: process an image and translate the recognized text into a target
 * language using the Ollama translation adapter.
 *
 * Run with:
 *   npx tsx examples/translate.ts ./path/to/image.png en
 *
 * Requires:
 *   - Ollama running at http://localhost:11434
 *   - The `aya:8b` model pulled (`ollama pull aya:8b`)
 *
 * What it demonstrates:
 *   - End-to-end pipeline: ingest → OCR → langdetect → translate.
 *   - Graceful failure: if Ollama is unreachable or the model isn't pulled,
 *     `result.translation` is null and `result.translationError` describes
 *     why. The OCR portion of the pipeline still succeeds.
 */

import { PolyOCR } from '../src/index.js';

const [, , path, target = 'en'] = process.argv;
if (!path) {
  console.error('Usage: npx tsx examples/translate.ts <image-file> [target-lang=en]');
  process.exit(1);
}

const pocr = new PolyOCR({
  ollamaUrl: 'http://localhost:11434',
  translationModel: 'aya:8b',
  verbose: true
});

await pocr.ready();

const result = await pocr.process(path, { translate: target, translationDomain: 'neutral' });

console.log('Source:', result.text);
console.log(`Detected: ${result.language ?? 'unknown'} (${result.languageConfidence.toFixed(2)})`);
console.log('---');
if (result.translation) {
  console.log(`Translation (${target}):`, result.translation);
} else {
  console.log('Translation skipped:', result.translationError);
}

await pocr.dispose();
