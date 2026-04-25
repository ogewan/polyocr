/**
 * Electron main process entry point.
 *
 * Responsibilities:
 *   - Create the BrowserWindow with `nodeIntegration: false`,
 *     `contextIsolation: true`, and the preload script wired up.
 *   - Instantiate the singleton `PolyOCR` instance with config loaded from
 *     the SQLite settings table (or sensible defaults on first run).
 *   - Register IPC handlers:
 *       polyocr:process            → pocr.process(input, options)
 *       polyocr:batch              → pocr.processBatch(inputs, options)
 *       polyocr:stream             → pocr.stream(...) — emits 'polyocr:stream:result'
 *                                    events for each yielded result
 *       polyocr:export             → pocr.export(results, options) → returns Buffer
 *       polyocr:build-reference    → pocr.buildReference(crop, label)
 *       polyocr:find-region        → pocr.findRegion(image, ref)
 *       shell:open-file-picker, shell:open-directory-picker, shell:save-file
 *       settings:get, settings:set
 *   - Register the configurable global screenshot hotkey via
 *     `globalShortcut.register`. On press, capture a screen region with
 *     `desktopCapturer`, run `pocr.process()`, and show a notification.
 *   - Create the system tray icon with a context menu: Open, Screenshot OCR, Quit.
 *
 * Why pipeline calls live in main (not renderer):
 *   - PolyOCR uses Node-only APIs (`worker_threads`, `child_process` for
 *     PaddleOCR, the `canvas` polyfill) that don't exist in the sandboxed
 *     renderer.
 *   - Renderer-side processing would also block the UI thread, defeating the
 *     point of having a worker pool.
 *
 * Phase 5 implements this in full.
 */
export {};
