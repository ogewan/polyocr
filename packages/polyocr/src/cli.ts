#!/usr/bin/env node
/**
 * CLI entry point. Installed as the `polyocr` bin via package.json.
 *
 * Subcommands:
 *
 *   polyocr process <file> [--translate <lang>] [--output <file>] [--format <fmt>]
 *   polyocr batch <dir>    [--translate <lang>] [--format <fmt>] [--include <list>]
 *                          [--fps <n>] [--ref <image>]
 *   polyocr detect <file>  [--roi "x,y,w,h"] [--translate <lang>]
 *
 * Shared flags:
 *   --output <path>     write the formatted result here; if omitted, stdout
 *   --format <fmt>      json | txt | csv | srt | vtt | zip (default: json)
 *   --include <list>    ZIP comma-separated: images,csv,json,txt
 *   --translate <lang>  ISO target language (omit to skip translation)
 *   --inpaint <mode>    chroma | blur | fill | clone
 *   --workers <n>       worker count (default 2)
 *   --concurrency <n>   batch concurrency (default = workers)
 *   --ollama <url>      override Ollama URL
 *   --langs <list>      Tesseract languages (default eng)
 *
 * Why a hand-rolled parser instead of `commander`/`yargs`:
 *   - The flag set is small and stable.
 *   - Avoids a dependency just for argv parsing — the published package is
 *     leaner.
 *   - Trivial to add new flags without learning the parser's DSL.
 *
 * Progress prints to stderr so stdout stays clean for piping JSON.
 */

import { writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, isAbsolute, resolve } from 'node:path';
import { PolyOCR } from './index.js';
import { exportResults } from './export/index.js';
import type { ExportOptions, OcrOptions, BatchOptions, BoundingBox, ProcessResult } from './types.js';

interface ParsedArgs {
  command: 'process' | 'batch' | 'detect';
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  if (argv.length === 0) return null;
  const command = argv[0] as ParsedArgs['command'];
  if (!['process', 'batch', 'detect'].includes(command)) return null;
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function flagStr(flags: ParsedArgs['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function parseRoi(s: string | undefined): BoundingBox | null {
  if (!s) return null;
  const parts = s.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function listImagesIn(dir: string): string[] {
  const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  return readdirSync(abs)
    .filter((f) => /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(extname(f)))
    .map((f) => join(abs, f))
    .filter((p) => statSync(p).isFile());
}

function logProgress(msg: string): void {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    printUsage();
    process.exit(1);
  }
  const { command, positional, flags } = args;

  const langs = flagStr(flags, 'langs')?.split(',') ?? ['eng'];
  const workers = Number(flagStr(flags, 'workers') ?? 2);
  const ollamaUrl = flagStr(flags, 'ollama');
  const translate = flagStr(flags, 'translate') ?? null;
  const inpaintMode = flagStr(flags, 'inpaint') as OcrOptions['inpaint'] | undefined;
  const format = (flagStr(flags, 'format') ?? 'json') as ExportOptions['format'];
  const outputPath = flagStr(flags, 'output');
  const includeList = flagStr(flags, 'include')?.split(',') as
    | NonNullable<ExportOptions['zip']>['include']
    | undefined;
  const fps = flags.fps ? Number(flagStr(flags, 'fps')) : undefined;
  const concurrency = Number(flagStr(flags, 'concurrency') ?? workers);

  const pocr = new PolyOCR({
    tesseractLanguages: langs,
    workerCount: workers,
    ...(ollamaUrl !== undefined && { ollamaUrl }),
    verbose: process.env.POLYOCR_VERBOSE === '1'
  });
  await pocr.ready();

  try {
    if (command === 'process') {
      const file = positional[0];
      if (!file) {
        printUsage();
        process.exit(1);
      }
      logProgress(`processing ${file}`);
      const opts: OcrOptions = {
        ...(translate !== null && { translate }),
        ...(inpaintMode !== undefined && { inpaint: inpaintMode }),
        output: { text: true, regions: true, image: !!inpaintMode }
      };
      const result = await pocr.process(file, opts);
      const exportOpts: ExportOptions = buildExportOpts(format, fps, includeList);
      await emit([result], exportOpts, outputPath);
    } else if (command === 'detect') {
      const file = positional[0];
      if (!file) {
        printUsage();
        process.exit(1);
      }
      const roi = parseRoi(flagStr(flags, 'roi'));
      logProgress(`processing ${file}${roi ? ` ROI=${JSON.stringify(roi)}` : ''}`);
      const opts: OcrOptions = {
        ...(roi && { regions: [roi] }),
        ...(translate !== null && { translate }),
        ...(inpaintMode !== undefined && { inpaint: inpaintMode }),
        output: { text: true, regions: true, image: !!inpaintMode }
      };
      const result = await pocr.process(file, opts);
      const exportOpts: ExportOptions = buildExportOpts(format, fps, includeList);
      await emit([result], exportOpts, outputPath);
    } else if (command === 'batch') {
      const dir = positional[0];
      if (!dir) {
        printUsage();
        process.exit(1);
      }
      const files = listImagesIn(dir);
      logProgress(`batch: ${files.length} images from ${dir}`);
      const refImage = flagStr(flags, 'ref');
      const baseOpts: BatchOptions = {
        concurrency,
        ...(translate !== null && { translate }),
        ...(inpaintMode !== undefined && { inpaint: inpaintMode }),
        ...(fps !== undefined && { fps }),
        output: { text: true, regions: true, image: !!inpaintMode }
      };
      const results: Awaited<ReturnType<typeof pocr.process>>[] = [];
      if (refImage) {
        // Build a reference once, then for each frame find the matching
        // region and use it as the per-image ROI.
        logProgress(`building reference from ${refImage}`);
        const ref = await pocr.buildReference(refImage, 'reference');
        let i = 0;
        for (const f of files) {
          logProgress(`  [${i + 1}/${files.length}] findRegion ${f}`);
          const bbox = await pocr.findRegion(f, ref);
          const r = await pocr.process(f, {
            ...baseOpts,
            ...(bbox && { regions: [bbox] }),
            index: i
          });
          logProgress(`  [${i + 1}/${files.length}] done (${r.durationMs.toFixed(0)}ms)`);
          results.push(r);
          i++;
        }
      } else {
        // Stream so progress can be reported.
        let done = 0;
        for await (const r of pocr.stream(files, baseOpts)) {
          done++;
          logProgress(`  [${done}/${files.length}] idx=${r.index} ${r.durationMs.toFixed(0)}ms`);
          results.push(r);
        }
        results.sort((a, b) => a.index - b.index);
      }
      const exportOpts: ExportOptions = buildExportOpts(format, fps, includeList);
      await emit(results, exportOpts, outputPath);
    }
  } finally {
    await pocr.dispose();
  }
}

function buildExportOpts(
  format: ExportOptions['format'],
  fps: number | undefined,
  includeList?: NonNullable<ExportOptions['zip']>['include']
): ExportOptions {
  const opts: ExportOptions = { format };
  if (fps !== undefined) opts.fps = fps;
  if (format === 'zip') {
    opts.zip = {
      include: includeList ?? ['json', 'csv'],
      imageFormat: 'png',
      manifest: true
    };
  }
  return opts;
}

async function emit(
  results: ProcessResult[],
  options: ExportOptions,
  outputPath: string | undefined
): Promise<void> {
  const out = await exportResults(results, options);
  // Buffer in Node, Blob in browser. CLI is Node-only — we always get Buffer.
  if (outputPath) {
    if (out instanceof Buffer) {
      await writeFile(outputPath, out);
    } else {
      const arr = await (out as Blob).arrayBuffer();
      await writeFile(outputPath, Buffer.from(arr));
    }
    logProgress(`wrote ${outputPath}`);
  } else {
    if (out instanceof Buffer) {
      process.stdout.write(out);
    } else {
      const arr = await (out as Blob).arrayBuffer();
      process.stdout.write(Buffer.from(arr));
    }
  }
}

function printUsage(): void {
  process.stderr.write(
    `polyocr — multilingual OCR + translation + inpainting

Usage:
  polyocr process <file>    [options]
  polyocr batch <directory> [options]
  polyocr detect <file>     [options] --roi "x,y,w,h"

Options:
  --translate <lang>     Translate to <lang> (omit to skip)
  --output <path>        Output file (default: stdout)
  --format <fmt>         json|txt|csv|srt|vtt|zip (default: json)
  --include <list>       ZIP contents: images,csv,json,txt
  --inpaint <mode>       chroma|blur|fill|clone
  --workers <n>          Tesseract worker count (default 2)
  --concurrency <n>      Batch concurrency (default = workers)
  --langs <list>         Tesseract languages (default eng)
  --ollama <url>         Ollama base URL (default http://localhost:11434)
  --fps <n>              Frames per second for SRT/VTT export
  --roi "x,y,w,h"        Restrict OCR to this region
  --ref <image>          Build a reference for batch positional drift
`
  );
}

main().catch((err) => {
  process.stderr.write(`polyocr: ${err?.message ?? err}\n`);
  process.exit(1);
});
