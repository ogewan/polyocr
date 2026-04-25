/**
 * Vision-LLM region detector.
 *
 * `detect(image)`: encodes the image to base64 PNG, sends a multimodal prompt to
 * Ollama (`llama3.2-vision` or `moondream2`) asking for a JSON array of bounding
 * boxes with descriptions. The LLM is much slower than OpenCV (1–10 seconds vs.
 * ~50ms) but handles unstructured / complex images far better.
 *
 * `findSimilar(image, reference)`: this is the workhorse for the instrument-
 * readout / drift-tolerance use case. We build the prompt from
 * `reference.description` (text), `reference.label` (text), and the full target
 * image, asking the LLM to locate the same region. The LLM returns a single bbox
 * or `null` if it can't find a confident match.
 *
 * Prompt strings are kept as named constants at the top of the module so they're
 * easy to tune without hunting through string concatenation. Each prompt phrase
 * has a comment explaining why it's there:
 *   - "Return ONLY a JSON array, no prose" — vision LLMs love to add commentary.
 *   - "If you cannot find the region, return null" — without this they hallucinate
 *     bboxes for absent regions.
 *   - "Coordinates are in image pixels, top-left origin" — the LLM otherwise
 *     wavers between normalized [0,1] and pixel coordinates.
 *
 * JSON parse failures are handled gracefully: we strip code fences, find the first
 * `{` or `[`, and try `JSON.parse` on the slice. On total parse failure we return
 * `[]` from `detect` and `null` from `findSimilar` rather than throwing.
 *
 * Phase 2 implements this in full.
 */
export {};
