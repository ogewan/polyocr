/**
 * Electron preload script.
 *
 * Runs in the renderer's process but with `contextBridge` access. Exposes
 * a curated `window.polyocr` and `window.shell` API to the renderer-side
 * React app.
 *
 * The renderer NEVER touches Node directly — `nodeIntegration: false`
 * and `contextIsolation: true` are set on the BrowserWindow. This is
 * the standard Electron security model: a compromised renderer (XSS in
 * user-supplied content, a malicious image's filename rendered
 * unescaped, etc.) cannot reach the filesystem, spawn processes, or
 * read environment variables. Only the explicit methods on
 * `contextBridge.exposeInMainWorld(...)` are reachable.
 *
 * # Stream + setup IPC pattern
 *
 *   `pocr.stream` and `runSetup` both emit progress events over time.
 *   The pattern: the renderer calls a single async method
 *   (`window.polyocr.stream(inputs, opts, onResult)`); preload
 *   generates a unique correlation id, subscribes to topic-namespaced
 *   events `polyocr:stream:result:<id>` and `polyocr:stream:done:<id>`,
 *   then invokes `polyocr:stream` with `{ id, inputs, opts }`. Main
 *   sends per-result events back on the topic, and a `done` event when
 *   the for-await loop exits. The Promise the renderer awaited
 *   resolves on `done` and rejects on error.
 *
 *   Correlation ids prevent multiple concurrent streams (e.g. user
 *   triggers a Batch run AND a screenshot OCR mid-batch) from
 *   delivering each other's events to the wrong listener.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  PolyOCRBridge,
  ShellBridge
} from './shared/window.js';
import type {
  SerializedProcessResult,
  SetupProgressEvent
} from './shared/types.js';

const polyocrBridge: PolyOCRBridge = {
  process: (input, options) =>
    ipcRenderer.invoke('polyocr:process', input, options),

  processBatch: (inputs, options) =>
    ipcRenderer.invoke('polyocr:batch', inputs, options),

  stream: (inputs, options, onResult) => {
    const id = crypto.randomUUID();
    const resultChannel = `polyocr:stream:result:${id}`;
    const doneChannel = `polyocr:stream:done:${id}`;
    const onResultEvent = (_e: IpcRendererEvent, result: SerializedProcessResult) => {
      onResult(result);
    };
    ipcRenderer.on(resultChannel, onResultEvent);
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ipcRenderer.off(resultChannel, onResultEvent);
        ipcRenderer.removeAllListeners(doneChannel);
      };
      ipcRenderer.once(doneChannel, (_e, error: string | null) => {
        cleanup();
        if (error) reject(new Error(error));
        else resolve();
      });
      ipcRenderer.invoke('polyocr:stream', { id, inputs, options }).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  },

  export: (results, options) =>
    ipcRenderer.invoke('polyocr:export', results, options),

  buildReference: (crop, label) =>
    ipcRenderer.invoke('polyocr:build-reference', crop, label),

  findRegion: (image, reference) =>
    ipcRenderer.invoke('polyocr:find-region', image, reference),

  setup: (options, onProgress) => {
    const id = crypto.randomUUID();
    const channel = `polyocr:setup:event:${id}`;
    const handler = (_e: IpcRendererEvent, event: SetupProgressEvent) => {
      onProgress?.(event);
    };
    ipcRenderer.on(channel, handler);
    return ipcRenderer
      .invoke('polyocr:setup', { id, options })
      .finally(() => {
        ipcRenderer.off(channel, handler);
      });
  },

  listProfiles: () => ipcRenderer.invoke('polyocr:list-profiles')
};

const shellBridge: ShellBridge = {
  openFilePicker: (options) => ipcRenderer.invoke('shell:open-file-picker', options),
  openDirectoryPicker: () => ipcRenderer.invoke('shell:open-directory-picker'),
  saveFile: (bytes, defaultName) =>
    ipcRenderer.invoke('shell:save-file', bytes, defaultName),
  getSettings: () => ipcRenderer.invoke('shell:get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('shell:set-settings', partial),
  getHistory: (limit) => ipcRenderer.invoke('shell:get-history', limit ?? 100),
  getSessionResults: (sessionId) =>
    ipcRenderer.invoke('shell:get-session-results', sessionId),
  clearHistory: () => ipcRenderer.invoke('shell:clear-history')
};

contextBridge.exposeInMainWorld('polyocr', polyocrBridge);
contextBridge.exposeInMainWorld('shell', shellBridge);
