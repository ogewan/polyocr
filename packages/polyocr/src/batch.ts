/**
 * Batch processor — owns the worker pool and the FIFO queue.
 *
 * Two main entry points:
 *
 *   - `processBatch(inputs, options)`: distributes work across `concurrency` slots,
 *     collects results, returns them in input-order (`result.index` matches the
 *     position in `inputs`).
 *
 *   - `stream(inputs, options)`: AsyncGenerator that yields each result the moment
 *     it finishes. Yields are unordered by completion time but every result still
 *     carries its original `index` so consumers (UIs, exporters) can reorder.
 *
 * Why parallel results come back out-of-order: image complexity varies wildly.
 * A page of clean printed text might OCR in 200ms; a manga panel with 8 speech
 * bubbles and CJK characters might take 3 seconds. With `concurrency: 4` the
 * faster jobs finish ahead of slower ones started earlier — `result.index` is
 * the only stable sort key.
 *
 * Cache integration: before dispatching an image to a worker, hash its pixel
 * buffer and check `cache.get(hash)`. On miss → run OCR → `cache.set(hash, result)`.
 * The cache is keyed only on OCR; translation runs after the cache check on
 * every image regardless.
 *
 * Phase 2 implements:
 *
 *   class BatchProcessor {
 *     constructor(opts: { concurrency, cache, runOne })
 *     processBatch(inputs, options): Promise<ProcessResult[]>
 *     stream(inputs, options): AsyncGenerator<ProcessResult>
 *   }
 */
export {};
