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
 *   --output <path>        write the formatted result here; if omitted, stdout
 *   --format <fmt>         json | txt | csv | srt | vtt | zip (default: json)
 *   --include <list>       comma-separated for ZIP: images,csv,json,txt
 *   --translate <lang>     ISO target language (omit to skip translation)
 *   --inpaint <mode>       chroma | blur | fill | clone
 *   --workers <n>          concurrency override
 *   --ollama <url>         override Ollama URL
 *
 * Progress is printed to stderr (so stdout stays clean for piping JSON).
 *
 * Phase 4 implements this in full.
 */
export {};
