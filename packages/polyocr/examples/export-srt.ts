/**
 * Example: process a directory of frames into an SRT subtitle file.
 *
 * Run with:
 *   npx tsx examples/export-srt.ts <frames-dir> <out-srt> <fps>
 *
 * Each frame becomes one subtitle block whose timestamp is derived from
 * the frame's index and the FPS argument.
 */

import { writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PolyOCR } from '../src/index.js';
import { exportResults } from '../src/export/index.js';

const [, , dir, outSrt = 'subtitles.srt', fpsArg = '24'] = process.argv;
if (!dir) {
  console.error('Usage: npx tsx examples/export-srt.ts <frames-dir> [out=subtitles.srt] [fps=24]');
  process.exit(1);
}
const fps = Number(fpsArg);
if (!Number.isFinite(fps) || fps <= 0) {
  console.error(`Invalid fps: ${fpsArg}`);
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((f) => /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(extname(f)))
  .sort()
  .map((f) => join(dir, f));
console.log(`${files.length} frames at ${fps} fps`);

const pocr = new PolyOCR({
  tesseractLanguages: (process.env.LANGS ?? 'eng').split(','),
  workerCount: 2
});
await pocr.ready();

const results = await pocr.processBatch(files, {
  translate: process.env.TARGET ?? 'en',
  concurrency: 2,
  fps
});

const buf = await exportResults(results, { format: 'srt', fps });
writeFileSync(outSrt, buf as Buffer);
console.log(`Wrote ${outSrt}`);

await pocr.dispose();
