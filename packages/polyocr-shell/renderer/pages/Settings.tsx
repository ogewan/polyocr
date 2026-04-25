/**
 * Settings page.
 *
 * Sections:
 *   - Engines:    Ollama URL, MTL model dropdown, vision model dropdown,
 *                 PaddleOCR enable toggle.
 *   - Defaults:   target language, inpaint mode, font family + weight + color,
 *                 chroma key color picker.
 *   - Performance: worker concurrency slider (1 to navigator.hardwareConcurrency).
 *   - Hotkey:     screenshot global shortcut recorder (captures key combo on
 *                 next press).
 *   - Cache:      "Clear scan history" button (drops both SQLite tables and
 *                 the inpainted-image directory).
 *
 * All settings are persisted via `window.shell.setSettings(partial)` which
 * writes to the SQLite settings table on the main side.
 *
 * Phase 5 implements this in full.
 */
export {};
