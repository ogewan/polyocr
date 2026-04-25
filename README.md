# PolyOCR

**Multilingual OCR + machine translation + image inpainting + region matching.** Built as two artifacts that share a pipeline.

## Two-artifact architecture

| Artifact | What it is | Where it runs |
|---|---|---|
| **`polyocr`** | Headless npm package — the OCR/translation/inpainting engine | Node 20+ or browsers (WASM) |
| **`polyocr-shell`** | Thin Electron desktop utility | Windows / macOS / Linux |

The shell is *just* a UI consumer of the package. **Everything that does real work lives in `polyocr`.** That separation is deliberate: the headless package is reusable in any JavaScript context — a browser extension, a Node CLI, a CI image-processing pipeline, another Electron app, a server-side render service.

If you only ever ship a desktop app, you'd still want this split. Coupling the OCR pipeline to Electron's main-process lifecycle would make it a pain to test, impossible to embed, and hostile to anyone who later wants to lift the pipeline into a worker or a server.

- [`packages/polyocr/`](./packages/polyocr/README.md) — the package
- [`packages/polyocr-shell/`](./packages/polyocr-shell/README.md) — the Electron app

## Use cases the design targets

- **Document scanning** — scan a multilingual document, extract text, translate to a target language, export JSON or CSV.
- **Manga / comics translation** — auto-detect speech bubbles, OCR (CJK strong), translate, **inpaint** the original text and render the translated text back in place.
- **Instrument readout batch capture** — a recurring use case where you have many photographs of an analog gauge or LCD whose position drifts slightly between frames. Build a *region reference* once from a representative image, then run a batch and the LLM region matcher locates the same readout in each frame.
- **Subtitle generation from video frames** — sample a video into frames, OCR each frame, export an SRT/VTT timeline using `result.index` and a configured FPS.

## Tech stack at a glance

- OCR: **Tesseract.js 5.x** (default, WASM, in-browser-capable) and **PaddleOCR** (better for CJK, complex layouts — runs via a spawned Python FastAPI server)
- Language detection: **`franc` 6.x** statistical detector first, **Ollama** vision LLM fallback for short / mixed / low-confidence text
- Translation: **Ollama** (`aya:8b`, 23 languages) by default; optional **DeepL** and **LibreTranslate** adapters
- Region detection: **OpenCV.js** contour-based + **Ollama** vision LLM (`llama3.2-vision`, `moondream2`)
- Image processing: **OpenCV.js** (WASM)
- Shell: **Electron 33+ / React 18 / Vite / TailwindCSS / better-sqlite3**

All adapters implement formal TypeScript interfaces (`OcrAdapter`, `TranslationAdapter`, `RegionDetector`) so the user can plug in a hosted OCR service, a different translation backend, or a custom region matcher without forking the package.

## Development

```bash
git clone <this repo>
cd polyocr
npm install                    # installs both workspaces
npm run dev:package            # build the package in watch mode
npm run dev:shell              # run the Electron shell against it
```

Each phase of the implementation is committed separately (`chore: phase N complete` / `feat: phase N — ...`) so the git history doubles as a tour of how the pipeline was built.

## License

MIT.
