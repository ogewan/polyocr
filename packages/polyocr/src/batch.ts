/**
 * Batch processor — owns the worker pool and the FIFO queue.
 *
 * Two main entry points:
 *
 *   - `processBatch(inputs, options)`: distributes work across `concurrency`
 *     slots, collects results, returns them in input-order (`result.index`
 *     matches the position in `inputs`).
 *
 *   - `stream(inputs, options)`: AsyncGenerator that yields each result the
 *     moment it finishes. Yields are unordered by completion time but every
 *     result still carries its original `index` so consumers (UIs,
 *     exporters) can reorder.
 *
 * Why parallel results come back out-of-order: image complexity varies
 * wildly. A page of clean printed text might OCR in 200ms; a manga panel
 * with 8 speech bubbles and CJK characters might take 3 seconds. With
 * `concurrency: 4` the faster jobs finish ahead of slower ones started
 * earlier — `result.index` is the only stable sort key.
 *
 * Cache integration is handled inside `runOne` (provided by the PolyOCR
 * caller) — the batch processor itself is cache-agnostic.
 */

import type { PolyOCRInput, OcrOptions, BatchOptions, ProcessResult } from './types.js';

interface BatchProcessorOptions {
  /** Per-image worker. Encapsulates ingest → cache → OCR → translate → inpaint. */
  runOne: (input: PolyOCRInput, options: OcrOptions) => Promise<ProcessResult>;
  /** Default concurrency if not overridden in BatchOptions. */
  defaultConcurrency: number;
}

export class BatchProcessor {
  private readonly runOne: BatchProcessorOptions['runOne'];
  private readonly defaultConcurrency: number;

  constructor(opts: BatchProcessorOptions) {
    this.runOne = opts.runOne;
    this.defaultConcurrency = opts.defaultConcurrency;
  }

  async processBatch(inputs: PolyOCRInput[], options: BatchOptions = {}): Promise<ProcessResult[]> {
    const out: (ProcessResult | undefined)[] = new Array(inputs.length);
    for await (const result of this.stream(inputs, options)) {
      out[result.index] = result;
    }
    // Assert all slots filled — a missing slot would mean runOne returned
    // undefined, which is a bug.
    for (let i = 0; i < out.length; i++) {
      if (out[i] === undefined) {
        throw new Error(`Batch processor produced no result for input index ${i}`);
      }
    }
    return out as ProcessResult[];
  }

  async *stream(inputs: PolyOCRInput[], options: BatchOptions = {}): AsyncGenerator<ProcessResult> {
    const concurrency = Math.max(1, options.concurrency ?? this.defaultConcurrency);
    const total = inputs.length;
    if (total === 0) return;

    let nextIndex = 0;
    // Each in-flight slot is a {key, promise} pair. The key is a stable id
    // we can use to remove the entry from the Map after `Promise.race`
    // resolves, since `then` flattens nested promises (so we can't use the
    // promise itself as the race winner identifier).
    type Slot = { key: number; promise: Promise<{ key: number; result: ProcessResult }> };
    const inflight = new Map<number, Slot>();
    let nextKey = 0;

    const debug = (msg: string) => {
      if (typeof process !== 'undefined' && process.env?.POLYOCR_VERBOSE === '1') {
        console.error(`[polyocr/batch] ${msg}`);
      }
    };

    const dispatch = (): void => {
      while (inflight.size < concurrency && nextIndex < total) {
        const i = nextIndex++;
        const key = nextKey++;
        debug(`dispatch slot key=${key} idx=${i} (inflight=${inflight.size + 1}/${concurrency})`);
        const promise = (async () => {
          // Per-image options — we set `index` so the result carries the
          // input position even when results race ahead/behind each other.
          const perImage: OcrOptions = { ...options, index: i };
          const result = await this.runOne(inputs[i], perImage);
          debug(`runOne done idx=${i} key=${key} (${result.durationMs.toFixed(0)}ms)`);
          return { key, result };
        })();
        inflight.set(key, { key, promise });
      }
    };

    dispatch();
    while (inflight.size > 0) {
      debug(`race over ${inflight.size} slots`);
      const { key, result } = await Promise.race(
        Array.from(inflight.values()).map((s) => s.promise)
      );
      debug(`race winner key=${key} idx=${result.index}; deleting & yielding`);
      inflight.delete(key);
      yield result;
      dispatch();
    }
    debug(`stream exhausted`);
  }
}
