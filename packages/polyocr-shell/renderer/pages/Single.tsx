/**
 * Single-image page.
 *
 * Layout:
 *   - Drag-drop zone (accepts files or pasted clipboard images).
 *   - Left column: source image preview.
 *   - Right column: ResultPanel.
 *   - Below: target language picker, inpaint mode picker, "Process" button.
 *
 * On "Process" click: calls `window.polyocr.process(input, options)`, displays
 * the result via ResultPanel, and (if `inpaint` was selected) renders the
 * inpainted output in an InpaintCanvas below.
 *
 * Phase 5 implements this in full.
 */
export {};
