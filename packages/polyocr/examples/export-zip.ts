/**
 * Example: batch process + inpaint + export ZIP.
 *
 * Run with:
 *   npx tsx examples/export-zip.ts <directory> <out-zip>
 *
 * Produces a ZIP with: results.csv, results.json, images/0001.png ...,
 * text/0001.txt ..., manifest.json.
 */

import { writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PolyOCR } from '../src/index.js';
import { exportResults } from '../src/export/index.js';

const [, , dir, outZip = 'export.zip'] = process.argv;
if (!dir) {
  console.error('Usage: npx tsx examples/export-zip.ts <directory> [out=export.zip]');
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((f) => /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(extname(f)))
  .map((f) => join(dir, f));
console.log(`Processing ${files.length} files...`);

const pocr = new PolyOCR({
  tesseractLanguages: (process.env.LANGS ?? 'eng').split(','),
  workerCount: 2
});
await pocr.ready();

const results = await pocr.processBatch(files, {
  inpaint: 'blur',
  output: { text: true, regions: true, image: true },
  concurrency: 2
});

const out = await exportResults(results, {
  format: 'zip',
  zip: { include: ['images', 'csv', 'json', 'txt'], imageFormat: 'png', manifest: true }
});

writeFileSync(outZip, out as Buffer);
console.log(`Wrote ${outZip} (${(out as Buffer).length} bytes)`);

await pocr.dispose();
