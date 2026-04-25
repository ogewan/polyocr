/**
 * Side-by-side inpaint preview component.
 *
 * Renders two canvases: source image on the left, inpainted result on the
 * right. Above them, three tabs: `inpainted`, `overlay`, `bboxes-only`.
 * Switching tabs re-renders the right canvas via `pocr.renderToCanvas(result,
 * canvas, { mode })`.
 *
 * `inpainted` is the default mode for users who want to verify the final
 * output. `overlay` is useful for proofreading translation placement without
 * the fill obscuring context. `bboxes-only` is debug-mode — the user can see
 * exactly what regions OCR detected.
 *
 * Phase 5 implements this in full.
 */
export {};
