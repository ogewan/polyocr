# polyocr-shell

Thin Electron desktop UI on top of the [`polyocr`](../polyocr/README.md) package. The shell exists to give non-developers a friendly way to run the pipeline; nothing pipeline-related lives in this package.

## Run in dev

From the workspace root:

```bash
npm install
npm run dev:package      # build polyocr in watch mode
npm run dev:shell        # launch Electron with hot-reloaded React
```

`npm run dev:shell` runs Vite in dev-server mode for the renderer, and Electron in main-process mode pointed at `http://localhost:5173`.

## Build

```bash
npm run build --workspace=polyocr-shell
npm run build:installer --workspace=polyocr-shell
```

`build` produces a static renderer bundle plus compiled main/preload JS. `build:installer` runs `electron-builder` against the included config to produce per-platform installers (NSIS on Windows, DMG on macOS, AppImage on Linux).

## Architecture

The shell has three processes:

- **Main** (`main.ts`) — Node-side. Owns the `PolyOCR` instance. All pipeline calls run here so the renderer never blocks. Owns the SQLite scan history. Registers the screenshot global shortcut and system tray.
- **Preload** (`preload.ts`) — runs in the renderer's process but with `contextBridge` access to a curated `polyocr` API. `nodeIntegration: false`, `contextIsolation: true` — the renderer cannot reach Node directly.
- **Renderer** (`renderer/`) — React app. Talks to main only via `window.polyocr.*` (defined by preload).

## IPC bridge

Exposed on `window.polyocr`:

| Method | Calls |
|---|---|
| `process(input, options)` | `polyocr:process` IPC → main calls `pocr.process()` |
| `processBatch(inputs, options)` | `polyocr:batch` |
| `stream(inputs, options, onResult)` | `polyocr:stream` + listens for `polyocr:stream:result` events |
| `export(results, options)` | `polyocr:export` → returns Buffer that renderer saves via shell.saveFile |
| `buildReference(crop, label)` | `polyocr:build-reference` |
| `findRegion(image, ref)` | `polyocr:find-region` |

Plus `window.shell`:

- `openFilePicker(options)` / `openDirectoryPicker(options)`
- `saveFile(buffer, defaultName)`
- `getSettings()` / `setSettings(partial)`

## Pages

- **Single** (`renderer/pages/Single.tsx`) — drag-drop one image, choose target language and inpaint mode, see result side-by-side.
- **Batch** (`renderer/pages/Batch.tsx`) — pick a directory or drop multiple files, configure options, watch a streamed progress table fill in, export to JSON / CSV / SRT / VTT / ZIP.
- **MangaMode** (`renderer/pages/MangaMode.tsx`) — image viewer with auto-detect speech bubbles toggled on by default. Each panel shows OCR result, translation, and inpaint preview side-by-side.
- **Settings** (`renderer/pages/Settings.tsx`) — Ollama URL, model selectors (MTL + vision), PaddleOCR toggle, default language, default inpaint mode, font picker, worker count, chroma key color, screenshot hotkey recorder.

## ROI selector

`renderer/components/RoiSelector.tsx` is a canvas overlay that lets the user click-drag rectangles onto an image. Each rectangle gets a label and an include/exclude type toggle. Output is a serialized `BoundingBox[]` and (for "match this in other images") `RegionReference[]` ready to feed into batch options.

The component handles canvas-coordinate ↔ image-coordinate translation correctly when the canvas is CSS-scaled or has a devicePixelRatio backing-store ratio.

## Screenshot hotkey

The main process registers a global shortcut (configurable, default `CommandOrControl+Shift+O`) using `globalShortcut.register`. On press it captures a screen region (via `desktopCapturer` + `nativeImage`), feeds the result into `pocr.process()`, and shows a notification with the recognized text + a "copy translation" action.

## SQLite scan history

`better-sqlite3`. Database lives at `app.getPath('userData')/polyocr.db`. Two tables:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,             -- uuid
  created_at INTEGER,              -- unix ms
  mode TEXT,                       -- 'single' | 'batch' | 'manga'
  source_path TEXT,                -- file or directory the user processed
  options_json TEXT,               -- the full options object as JSON
  result_count INTEGER             -- denormalized for quick history listing
);

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  index INTEGER,                   -- result.index
  text TEXT,
  language TEXT,
  translation TEXT,
  duration_ms INTEGER,
  cached INTEGER                   -- 0|1
);
```

Inpainted images are NOT stored in SQLite — they go to a sibling `images/` directory, named by `${session_id}/${index}.png`. The shell offers a "Clear history" action that drops both tables and the directory.
