/**
 * Public entry point for the polyocr package.
 *
 * Re-exports the `PolyOCR` class, every type from `types.ts`, and the formal
 * adapter interfaces. Consumers should import from `'polyocr'` — the deeper paths
 * (`'polyocr/adapters'`, etc.) are exposed for advanced use only.
 *
 * Phase 1 wires this up with the actual `PolyOCR` class. Phase 0 leaves it empty
 * to keep the package buildable while the implementation files are still stubs.
 */
export {};
