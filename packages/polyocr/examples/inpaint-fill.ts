/**
 * Example: process an image with inpaint mode 'fill'.
 *
 * The pipeline:
 *   1. OCR the image.
 *   2. Translate the recognized text into the target language.
 *   3. For each OCR bbox: sample perimeter pixels → median color → fill
 *      the bbox interior → render the translated text on top.
 *   4. Save the inpainted image to disk.
 *
 * Run with:
 *   npx tsx examples/inpaint-fill.ts <image> <target-lang> <out-png>
 *
 * Requires Ollama for translation. If Ollama isn't running, the regions
 * are filled with the median color but no text is rendered (translations
 * are null).
 */

import { writeFileSync } from 'node:fs';
import { PolyOCR } from '../src/index.js';

const [, , inFile, target = 'en', outFile = 'inpaint-out.png'] = process.argv;
if (!inFile) {
  console.error('Usage: npx tsx examples/inpaint-fill.ts <image> [target-lang=en] [out=inpaint-out.png]');
  process.exit(1);
}

const pocr = new PolyOCR({
  tesseractLanguages: (process.env.LANGS ?? 'eng').split(','),
  workerCount: 1,
  verbose: true
});
await pocr.ready();

const result = await pocr.process(inFile, {
  inpaint: 'fill',
  translate: target,
  output: { text: true, regions: true, image: true }
});

console.log(`Source text: ${result.text.slice(0, 200)}`);
console.log(`Translated: ${result.translation ?? '(translation failed: ' + result.translationError + ')'}`);
console.log(`Inpainted: ${result.inpaintedImage ? `${result.inpaintedImage.width}x${result.inpaintedImage.height}` : 'null'}`);

if (result.inpaintedImage) {
  const canvasMod = await import('@napi-rs/canvas');
  const c = canvasMod.createCanvas(result.inpaintedImage.width, result.inpaintedImage.height);
  const ctx = c.getContext('2d');
  const napi = ctx.createImageData(result.inpaintedImage.width, result.inpaintedImage.height);
  napi.data.set(result.inpaintedImage.data);
  ctx.putImageData(napi, 0, 0);
  const png = await c.encode('png');
  writeFileSync(outFile, png);
  console.log(`Wrote ${outFile} (${png.length} bytes)`);
}

await pocr.dispose();
