/**
 * Vite config for the Electron renderer.
 *
 * The renderer is a regular React + Vite SPA that gets served by Electron's
 * main process either from disk (production) or from the dev server (development).
 *
 * The Electron main process and preload script are NOT bundled by this config —
 * they're compiled separately by `tsc -p tsconfig.main.json` so they keep their
 * Node + Electron API access intact and don't end up with browser-targeted output.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'esnext'
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
