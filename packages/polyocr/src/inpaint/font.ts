/**
 * Text rendering for inpaint modes that draw translated text back into the
 * image. Used by `inpaint/chroma.ts` and `inpaint/fill.ts`.
 *
 * Why this is more than just `ctx.fillText(text, x, y)`:
 *
 * Canvas has no CSS layout. There's no `text-overflow`, no `word-wrap`, no
 * `flex` to stretch text to fit a region. The only primitives are
 * `ctx.measureText(s)` and `ctx.fillText(s, x, y)`. So layout is manual.
 *
 * Algorithm:
 *   1. Binary search the font size in [minSize, maxSize]. For each candidate:
 *        - Set ctx.font.
 *        - Word-wrap greedily: measure each word + ' ', append to current
 *          line if it fits within (bbox.w - 2*padding), else new line.
 *        - Total height = lines.length * lineHeight * fontSize.
 *        - Acceptable iff height ≤ (bbox.h - 2*padding) AND longest line's
 *          width ≤ (bbox.w - 2*padding).
 *      Pick the largest acceptable size. Halt at 1px interval.
 *   2. Render the wrapped text vertically centered within the bbox.
 *
 * Why binary search (not linear):
 *   - Acceptable range can be 8–64 — 56 candidates per region.
 *   - 50 manga panels × 6 bubbles each × 56 calls = 16,800 measurements.
 *     Binary search drops that to ~6 per region, ~1,800 per batch.
 *   - measureText isn't free — it's the canvas internally rendering the text
 *     into a hidden context for metrics. Avoiding 90% of the calls matters.
 *
 * Font loading: the package does not currently bundle a Noto Sans subset —
 * we rely on whatever font the host context provides for the requested
 * family (system fonts in Node, browser/OS fonts in browsers). The
 * FontConfig.family default is "sans-serif" so we always have a fallback.
 * Bundling Noto Sans is queued for Phase 6.
 */

import type { BoundingBox, FontConfig } from '../types.js';

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const DEFAULTS: Required<FontConfig> = {
  family: 'sans-serif',
  minSize: 8,
  maxSize: 64,
  color: '#000000',
  padding: 4,
  bold: false,
  italic: false,
  lineHeight: 1.2
};

export function renderTextIntoRegion(
  ctx: AnyCtx,
  text: string,
  bbox: BoundingBox,
  config: FontConfig = {}
): void {
  // Strip undefined-valued properties from `config` so they don't override
  // the defaults via spread (in TS strict mode, optional fields can be
  // explicitly `undefined`, which would clobber `DEFAULTS.color`).
  const cleaned: Partial<FontConfig> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined) (cleaned as any)[k] = v;
  }
  const c: Required<FontConfig> = { ...DEFAULTS, ...cleaned };
  const innerW = bbox.w - 2 * c.padding;
  const innerH = bbox.h - 2 * c.padding;
  if (innerW < 4 || innerH < 4 || !text.trim()) return;

  // Binary search the largest font size that fits.
  const fit = findBestFontSize(ctx, text, innerW, innerH, c);
  if (!fit) return;

  ctx.save();
  ctx.fillStyle = c.color;
  ctx.font = fontString(c, fit.fontSize);
  ctx.textBaseline = 'top';

  // Vertically center the wrapped block within the bbox.
  const blockHeight = fit.lines.length * fit.lineH;
  const yStart = bbox.y + c.padding + Math.max(0, (innerH - blockHeight) / 2);
  for (let i = 0; i < fit.lines.length; i++) {
    ctx.fillText(fit.lines[i], bbox.x + c.padding, yStart + i * fit.lineH);
  }
  ctx.restore();
}

interface Fit {
  fontSize: number;
  lineH: number;
  lines: string[];
}

function findBestFontSize(
  ctx: AnyCtx,
  text: string,
  innerW: number,
  innerH: number,
  c: typeof DEFAULTS
): Fit | null {
  let lo = c.minSize;
  let hi = c.maxSize;
  let best: Fit | null = null;

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    ctx.font = fontString(c, mid);
    const lineH = mid * c.lineHeight;
    const lines = wrapText(ctx, text, innerW);
    const longest = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
    const fits = longest <= innerW && lines.length * lineH <= innerH;
    if (fits) {
      best = { fontSize: mid, lineH, lines };
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // Verify the lower bound is at least minSize-fit; otherwise the bbox is
  // simply too small for this text — return null and the caller renders
  // nothing rather than overflowing pixels outside the bbox.
  if (!best) {
    ctx.font = fontString(c, c.minSize);
    const lineH = c.minSize * c.lineHeight;
    const lines = wrapText(ctx, text, innerW);
    const longest = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
    if (longest <= innerW && lines.length * lineH <= innerH) {
      best = { fontSize: c.minSize, lineH, lines };
    }
  }
  return best;
}

/**
 * Greedy word-wrap. Splits on whitespace, appends words while they fit,
 * starts a new line when the next word would overflow. Words longer than
 * the available width are placed on their own line — overflow is not
 * hyphenated (would require a dictionary).
 */
function wrapText(ctx: AnyCtx, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split(/\r?\n/);
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = current + ' ' + words[i];
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }
  return lines;
}

function fontString(c: typeof DEFAULTS, size: number): string {
  const weight = c.bold ? 'bold' : 'normal';
  const style = c.italic ? 'italic' : 'normal';
  return `${style} ${weight} ${size}px ${c.family}`;
}
