/**
 * Example: instrument-readout drift tolerance via LLM region matching.
 *
 * The premise: you have many photos of a treadmill / gauge / dashboard
 * whose position drifts a few dozen pixels frame-to-frame because the
 * camera or rig isn't perfectly still. A static `BoundingBox` won't catch
 * the readout in every frame. So:
 *
 *   1. From a representative frame + a hand-cropped image of the readout,
 *      build a RegionReference. The vision LLM produces a description that
 *      is robust to mild changes in lighting / scale / rotation.
 *   2. For each frame, ask the LLM to locate the same readout (returns a
 *      bbox or null if it can't find it).
 *   3. Run OCR with `regions: [bbox]` so we read only the readout — much
 *      faster than full-frame OCR and free of distractor text.
 *
 * Run with:
 *   npx tsx examples/region-matching.ts <ref-crop> <ref-label> <frame> [<frame> ...]
 *
 * Requires:
 *   - Ollama running with a vision model:  ollama pull llama3.2-vision
 */

import { PolyOCR } from '../src/index.js';

const [, , refCrop, refLabel, ...frames] = process.argv;
if (!refCrop || !refLabel || frames.length === 0) {
  console.error('Usage: npx tsx examples/region-matching.ts <ref-crop> <ref-label> <frame> [<frame> ...]');
  process.exit(1);
}

const pocr = new PolyOCR({
  ollamaUrl: 'http://localhost:11434',
  visionModel: 'llama3.2-vision',
  workerCount: 1,
  verbose: true
});

await pocr.ready();

console.log(`Building reference from ${refCrop} (label="${refLabel}")...`);
const ref = await pocr.buildReference(refCrop, refLabel);
console.log(`Reference description: ${ref.description}`);
console.log(`---`);

for (const frame of frames) {
  console.log(`Frame: ${frame}`);
  const bbox = await pocr.findRegion(frame, ref);
  if (!bbox) {
    console.log(`  (region not found)`);
    continue;
  }
  console.log(`  region: x=${bbox.x} y=${bbox.y} ${bbox.w}x${bbox.h}`);
  const result = await pocr.process(frame, { regions: [bbox] });
  console.log(`  text:   ${result.text.replace(/\s+/g, ' ')}`);
}

await pocr.dispose();
