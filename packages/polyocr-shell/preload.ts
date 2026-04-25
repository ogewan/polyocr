/**
 * Electron preload script.
 *
 * Runs in the renderer's process but with `contextBridge` access. Exposes a
 * curated `window.polyocr` and `window.shell` API to the renderer-side React
 * app.
 *
 * The renderer NEVER touches Node directly — the BrowserWindow is created with
 * `nodeIntegration: false` and `contextIsolation: true`. This is the standard
 * Electron security model: a compromised renderer (XSS in user-supplied content,
 * a malicious image's filename rendered unescaped, etc.) cannot reach the
 * filesystem, spawn processes, or read environment variables. Only the explicit
 * methods on `contextBridge.exposeInMainWorld(...)` are reachable.
 *
 * Exposed API:
 *   window.polyocr.process(input, options)
 *   window.polyocr.processBatch(inputs, options)
 *   window.polyocr.stream(inputs, options, onResult)
 *   window.polyocr.export(results, options)
 *   window.polyocr.buildReference(crop, label)
 *   window.polyocr.findRegion(image, ref)
 *   window.shell.openFilePicker(options)
 *   window.shell.openDirectoryPicker(options)
 *   window.shell.saveFile(buffer, defaultName)
 *   window.shell.getSettings()
 *   window.shell.setSettings(partial)
 *
 * Phase 5 implements this in full.
 */
export {};
