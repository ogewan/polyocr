/**
 * Vite library-mode build for the `polyocr` package.
 *
 * Outputs both ES modules (for modern bundlers / Node ESM) and CommonJS (for legacy
 * Node and older toolchains). The CLI entry is also bundled separately so the `polyocr`
 * bin can be installed standalone via `npm install -g polyocr`.
 *
 * `vite-plugin-dts` is intentionally not used for the rolled .d.ts (we run `tsc`
 * separately) — the per-file declaration output is more useful for downstream
 * consumers who want to navigate types in their IDE.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const externals = [
  'tesseract.js',
  'franc',
  'jszip',
  'better-sqlite3',
  'canvas',
  'node:fs',
  'node:path',
  'node:crypto',
  'node:worker_threads',
  'node:child_process',
  'node:net',
  'node:os',
  'node:url',
  'fs',
  'path',
  'crypto',
  'worker_threads',
  'child_process',
  'net',
  'os',
  'url'
];

export default defineConfig({
  build: {
    target: 'esnext',
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        cli: resolve(__dirname, 'src/cli.ts'),
        adapters: resolve(__dirname, 'src/adapters.ts')
      },
      formats: ['es', 'cjs'],
      fileName: (format, name) => `${name}.${format === 'es' ? 'js' : 'cjs'}`
    },
    rollupOptions: {
      external: externals,
      output: {
        preserveModules: false
      }
    },
    emptyOutDir: true
  }
});
