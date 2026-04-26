/**
 * Electron main process entry point.
 *
 * Owns:
 *   - The singleton `PolyOCR` instance (Node-only APIs forbid running it
 *     in the renderer).
 *   - The `ShellDb` (better-sqlite3) for settings + scan history.
 *   - The BrowserWindow + tray + global screenshot hotkey.
 *   - All IPC handlers (`polyocr:*` and `shell:*` channels).
 *
 * # Why pipeline calls live in main
 *   `PolyOCR` uses `worker_threads` (Tesseract scheduler), `child_process`
 *   (PaddleOCR Python bridge), `@napi-rs/canvas` (Node-side ImageData
 *   decoding), and `fs` (file inputs). None of those work in a sandboxed
 *   renderer. Even if they did, blocking the renderer's UI thread with
 *   OCR (200ms–2s per image) would defeat the worker pool's purpose.
 *
 * # Lifecycle
 *   - whenReady → init db → build PolyOCR from settings → register IPC →
 *     create window → create tray → register screenshot hotkey
 *   - settings change → reinstantiate PolyOCR (cheap; ~0ms construction
 *     + lazy adapter probes on first use)
 *   - will-quit → unregister shortcuts → dispose PolyOCR → close db
 *
 * # Tray + screenshot keep the app alive
 *   `window-all-closed` does NOT quit. The tray's right-click menu is
 *   the documented way to quit. This matches macOS conventions and
 *   keeps the screenshot hotkey usable when the user has closed the
 *   main window.
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  Notification,
  desktopCapturer,
  screen
} from 'electron';
import { join, extname } from 'node:path';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PolyOCR } from 'polyocr';
import type {
  ProcessResult,
  PolyOCRInput,
  BatchOptions,
  ExportOptions,
  RegionReference,
  BoundingBox,
  ProcessTimings
} from 'polyocr';
import { runSetup, formatProfileList, listProfiles } from 'polyocr/setup';
import type { SetupOptions, PullProgress } from 'polyocr/setup';
import { ShellDb } from './db.js';
import { serializeResult } from './serialize.js';
import { buildPolyOCR, pipelineRelevantChanged } from './pipeline.js';
import type {
  Settings,
  ModelProfile,
  SerializedProcessResult,
  SetupProgressEvent,
  RendererOcrOptions
} from './shared/types.js';

// ── Module state ────────────────────────────────────────────────────────

let pocr: PolyOCR | null = null;
let db: ShellDb | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let activeHotkey: string | null = null;

// ── PolyOCR lifecycle ───────────────────────────────────────────────────

/**
 * Tear down the existing PolyOCR (if any) and rebuild from current
 * settings. Called when the user saves Settings.
 *
 * The actual `buildPolyOCR(settings)` factory lives in `pipeline.ts`
 * so the smoke test can construct a PolyOCR from a Settings object
 * without importing Electron.
 */
async function reinstantiatePolyOCR(): Promise<void> {
  await pocr?.dispose();
  pocr = await buildPolyOCR(db!.getSettings());
}

// ── IPC: pipeline ───────────────────────────────────────────────────────

function registerPipelineHandlers(): void {
  ipcMain.handle(
    'polyocr:process',
    async (_event, input: PolyOCRInput, options: RendererOcrOptions = {}) => {
      const result = await pocr!.process(input, options);
      return serializeResult(result);
    }
  );

  ipcMain.handle(
    'polyocr:batch',
    async (_event, inputs: PolyOCRInput[], options: BatchOptions = {}) => {
      const results = await pocr!.processBatch(inputs, options);
      return results.map(serializeResult);
    }
  );

  // Stream pattern: the renderer's preload generates a unique `id` and
  // subscribes to `polyocr:stream:result:${id}` + `polyocr:stream:done:${id}`
  // before invoking this handler. We send per-result events on the
  // namespaced channel and exactly one done event when the stream
  // exits (with `null` on success or an error message on failure).
  ipcMain.handle(
    'polyocr:stream',
    async (
      event,
      payload: { id: string; inputs: PolyOCRInput[]; options?: BatchOptions }
    ) => {
      const { id, inputs, options } = payload;
      const resultChannel = `polyocr:stream:result:${id}`;
      const doneChannel = `polyocr:stream:done:${id}`;
      try {
        for await (const r of pocr!.stream(inputs, options ?? {})) {
          // event.sender may be destroyed if the renderer reloads
          // mid-stream — short-circuit rather than throw on every event.
          if (event.sender.isDestroyed()) return;
          event.sender.send(resultChannel, serializeResult(r));
        }
        if (!event.sender.isDestroyed()) {
          event.sender.send(doneChannel, null);
        }
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        if (!event.sender.isDestroyed()) {
          event.sender.send(doneChannel, msg);
        }
        throw cause;
      }
    }
  );

  ipcMain.handle(
    'polyocr:export',
    async (_event, results: SerializedProcessResult[], options: ExportOptions) => {
      // Reconstruct ProcessResults from the serialized form. polyocr's
      // export helpers only read `data` / `width` / `height` off the
      // image — duck-typing is safe here and avoids round-tripping
      // pixels through @napi-rs/canvas.createImageData just to be
      // re-decoded on the export side.
      const reconstructed: ProcessResult[] = results.map((s) => ({
        index: s.index,
        text: s.text,
        language: s.language,
        languageConfidence: s.languageConfidence,
        regions: s.regions,
        translation: s.translation,
        translationError: s.translationError,
        inpaintedImage: s.inpaintedImage
          ? ({
              data: s.inpaintedImage.data,
              width: s.inpaintedImage.width,
              height: s.inpaintedImage.height,
              colorSpace: 'srgb'
            } as ImageData)
          : null,
        cached: s.cached,
        durationMs: s.durationMs
      }));
      const out = await pocr!.export(reconstructed, options);
      // Buffer in Node, Blob in browsers — main is always Node.
      if (out instanceof Buffer) return new Uint8Array(out);
      // Defensive: if something returns a Blob in a future polyocr
      // refactor, decode it here so the renderer always gets a
      // Uint8Array.
      const arr = await (out as Blob).arrayBuffer();
      return new Uint8Array(arr);
    }
  );

  ipcMain.handle(
    'polyocr:build-reference',
    async (_event, crop: PolyOCRInput, label: string): Promise<RegionReference> => {
      return await pocr!.buildReference(crop, label);
    }
  );

  ipcMain.handle(
    'polyocr:find-region',
    async (
      _event,
      image: PolyOCRInput,
      reference: RegionReference
    ): Promise<BoundingBox | null> => {
      return await pocr!.findRegion(image, reference);
    }
  );

  // Setup IPC: same correlation-id pattern as stream. The renderer
  // subscribes to `polyocr:setup:event:${id}` for live progress
  // (Ollama log lines, /api/pull progress) and awaits the invoke for
  // the final SetupResult.
  ipcMain.handle(
    'polyocr:setup',
    async (event, payload: { id: string; options: SetupOptions }) => {
      const { id, options } = payload;
      const channel = `polyocr:setup:event:${id}`;
      const send = (e: SetupProgressEvent) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, e);
      };
      const result = await runSetup({
        ...options,
        log: (line: string) => send({ kind: 'log', message: line }),
        onPullProgress: (e: PullProgress) =>
          send({
            kind: 'pull-progress',
            pull: {
              status: e.status,
              ...(e.percent !== undefined && { percent: e.percent }),
              ...(e.completed !== undefined && { completed: e.completed }),
              ...(e.total !== undefined && { total: e.total })
            }
          }),
        // Renderer-side `confirm()` would block IPC — we route the
        // prompt through a synchronous one-line accept by treating
        // `--yes` as the only acceptable mode from the shell. The UI
        // shows its own dialog before invoking, so by the time setup
        // runs the user has already consented.
        prompt: async () => true,
        yes: true
      });
      // Setup may have changed the model — reinstantiate so the
      // PolyOCR we hand future calls to picks up the new translator.
      if (result.status === 'ready' || result.status === 'pulled' || result.status === 'installed') {
        await reinstantiatePolyOCR();
      }
      send({ kind: 'done', exitCode: result.exitCode });
      return result;
    }
  );

  ipcMain.handle('polyocr:list-profiles', () => formatProfileList());

  // Structured-data variant for the Settings page model picker. Reads
  // the same registry as `polyocr:list-profiles` but returns the
  // ModelProfile[] directly. Custom profiles are loaded from the
  // current settings' configured path so the dropdown reflects what
  // the user has actually registered.
  ipcMain.handle('polyocr:get-profiles', async () => {
    const settings = db?.getSettings();
    let custom: ModelProfile[] | undefined;
    if (settings?.customTranslationProfilesPath) {
      try {
        const raw = await readFile(settings.customTranslationProfilesPath, 'utf8');
        const parsed = JSON.parse(raw) as ModelProfile[];
        if (Array.isArray(parsed)) custom = parsed;
      } catch {
        // Same fail-soft policy as buildPolyOCR — bad file just falls
        // back to built-ins, no exception.
      }
    }
    return listProfiles(custom);
  });
}

// ── IPC: shell utilities ────────────────────────────────────────────────

function registerShellHandlers(): void {
  ipcMain.handle(
    'shell:open-file-picker',
    async (
      _event,
      options: { multi?: boolean; extensions?: string[] } = {}
    ): Promise<string[] | null> => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        properties: options.multi ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [
          {
            name: 'Images',
            extensions: options.extensions ?? ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'gif']
          },
          { name: 'All files', extensions: ['*'] }
        ]
      });
      return result.canceled ? null : result.filePaths;
    }
  );

  ipcMain.handle('shell:open-directory-picker', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      properties: ['openDirectory']
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    'shell:save-file',
    async (_event, bytes: Uint8Array, defaultName: string): Promise<string | null> => {
      const result = await dialog.showSaveDialog(mainWindow ?? undefined!, {
        defaultPath: defaultName
      });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, Buffer.from(bytes));
      return result.filePath;
    }
  );

  ipcMain.handle('shell:get-settings', () => db!.getSettings());

  ipcMain.handle(
    'shell:set-settings',
    async (_event, partial: Partial<Settings>): Promise<void> => {
      const before = db!.getSettings();
      db!.setSettings(partial);
      const after = db!.getSettings();
      // Reinstantiate PolyOCR if any pipeline-relevant field changed.
      // Settings like the screenshot hotkey don't need a rebuild.
      if (pipelineRelevantChanged(before, after)) {
        await reinstantiatePolyOCR();
      }
      if (before.screenshotHotkey !== after.screenshotHotkey) {
        registerScreenshotHotkey(after.screenshotHotkey);
      }
    }
  );

  ipcMain.handle('shell:get-history', (_event, limit: number = 100) =>
    db!.listSessions(limit)
  );

  ipcMain.handle('shell:get-session-results', (_event, sessionId: string) =>
    db!.listResults(sessionId)
  );

  ipcMain.handle('shell:clear-history', () => db!.clearHistory());

  /**
   * Enumerate image files inside a directory. Matches the same
   * extensions the CLI's `polyocr batch` accepts (see
   * `listImagesIn` in the polyocr cli.ts). Used by the renderer's
   * Batch page directory picker — the renderer can't list a
   * directory through `dialog.showOpenDialog`'s file-picker mode,
   * so this IPC fills the gap.
   */
  ipcMain.handle(
    'shell:list-images-in-dir',
    async (_event, dirPath: string): Promise<string[]> => {
      const entries = await readdir(dirPath);
      const matches: string[] = [];
      for (const name of entries) {
        if (!IMAGE_EXTENSIONS.test(extname(name))) continue;
        const abs = join(dirPath, name);
        const s = await stat(abs).catch(() => null);
        if (s && s.isFile()) matches.push(abs);
      }
      // Sort for predictable order — directory enumeration on
      // Windows can return mixed order; the user expects alphabetical.
      return matches.sort();
    }
  );
}

const IMAGE_EXTENSIONS = /^\.(png|jpe?g|webp|bmp|tiff?|gif)$/i;

// ── Screenshot OCR ──────────────────────────────────────────────────────

/**
 * Capture the primary screen, run OCR on it, and show a notification
 * with the recognized text. Bound to the configurable global hotkey.
 *
 * `desktopCapturer.getSources` returns thumbnails sized to the
 * `thumbnailSize` option — we ask for the full primary-display size so
 * the resulting NativeImage is high-resolution enough for OCR.
 */
async function captureAndOcrScreenshot(): Promise<void> {
  if (!pocr) return;
  try {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height }
    });
    const primary = sources[0];
    if (!primary) {
      new Notification({
        title: 'PolyOCR screenshot',
        body: 'No screen source available.'
      }).show();
      return;
    }
    const png = primary.thumbnail.toPNG();
    const settings = db!.getSettings();
    const result = await pocr.process(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, {
      ...(settings.defaultTargetLanguage && { translate: settings.defaultTargetLanguage })
    });
    const text = result.translation ?? result.text;
    new Notification({
      title: 'PolyOCR screenshot',
      body: text.length > 200 ? text.slice(0, 197) + '…' : text || '(no text recognized)',
      silent: true
    }).show();
  } catch (cause) {
    console.error('[shell/main] screenshot OCR failed:', cause);
    new Notification({
      title: 'PolyOCR screenshot',
      body: `Failed: ${cause instanceof Error ? cause.message : String(cause)}`
    }).show();
  }
}

/**
 * (Re)register the global screenshot hotkey. Unregisters the previous
 * binding (if any) first; safe to call repeatedly.
 *
 * `globalShortcut.register` returns false when another app has claimed
 * the accelerator. We surface that as a notification rather than
 * silently failing — the user needs to know their hotkey conflict.
 */
function registerScreenshotHotkey(accelerator: string): void {
  if (activeHotkey) {
    globalShortcut.unregister(activeHotkey);
    activeHotkey = null;
  }
  if (!accelerator) return;
  const ok = globalShortcut.register(accelerator, () => {
    captureAndOcrScreenshot().catch((err) => {
      console.error('[shell/main] hotkey handler threw:', err);
    });
  });
  if (!ok) {
    new Notification({
      title: 'PolyOCR',
      body: `Could not register hotkey "${accelerator}" — another app may own it.`
    }).show();
    return;
  }
  activeHotkey = accelerator;
}

// ── Window + tray ───────────────────────────────────────────────────────

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox: false because preload uses Electron's `ipcRenderer`
      // and `contextBridge` which require the non-sandboxed renderer
      // process model. Renderer is still isolated (contextIsolation).
      sandbox: false,
      spellcheck: false
    }
  });

  // Dev: load Vite's HMR server. Prod: load the bundled HTML from disk.
  // VITE_DEV_SERVER_URL is set by the dev launcher; absent in
  // production builds.
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(import.meta.dirname, 'renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * System tray with Open / Screenshot OCR / Quit. Phase 5 ships an
 * empty placeholder icon (`nativeImage.createEmpty()`); Phase 6 swaps
 * in a real icon.
 */
function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('PolyOCR');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open PolyOCR',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createMainWindow();
        }
      }
    },
    {
      label: 'Screenshot OCR',
      click: () => {
        captureAndOcrScreenshot().catch(() => {
          /* notification surfaces the error */
        });
      }
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ]);
  tray.setContextMenu(menu);
}

// ── App lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  db = new ShellDb({
    dbPath: join(userData, 'polyocr.db'),
    imagesDir: join(userData, 'images')
  });
  const settings = db.getSettings();
  pocr = await buildPolyOCR(settings);
  registerPipelineHandlers();
  registerShellHandlers();
  createMainWindow();
  createTray();
  registerScreenshotHotkey(settings.screenshotHotkey);

  // macOS: re-create the window when the dock icon is clicked and no
  // windows are open. Standard Electron pattern.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// `window-all-closed` deliberately does NOT quit. The tray menu's Quit
// is the documented exit; closing the main window leaves the tray and
// screenshot hotkey alive. macOS also keeps the menu bar around.
app.on('window-all-closed', () => {
  // intentionally empty
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  await pocr?.dispose();
  db?.close();
});

// Avoid unused-import warning from importing types that the bundler
// won't reach but tsc verifies.
void undefined as unknown as ProcessTimings;
void existsSync;
