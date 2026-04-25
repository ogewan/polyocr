/**
 * Example: process an image with inpaint mode 'blur'.
 *
 * Pure obfuscation — Gaussian blurs every OCR bbox. Useful for redacting
 * sensitive content (phone numbers, addresses, license plates) without
 * caring about translations.
 *
 * Run with:
 *   npx tsx examples/inpaint-blur.ts <image> <out-png>
 */

import { writeFileSync } from 'node:fs';
import { PolyOCR } from '../src/index.js';

const [, , inFile, outFile = 'blur-out.png'] = process.argv;
if (!inFile) {
  console.error('Usage: npx tsx examples/inpaint-blur.ts <image> [out=blur-out.png]');
  process.exit(1);
}

const pocr = new PolyOCR({
  tesseractLanguages: (process.env.LANGS ?? 'eng').split(','),
  workerCount: 1,
  verbose: true
});
await pocr.ready();

const result = await pocr.process(inFile, {
  inpaint: 'blur',
  output: { text: true, regions: true, image: true }
});

console.log(`Detected ${result.regions.length} text regions; blurring all of them.`);

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
