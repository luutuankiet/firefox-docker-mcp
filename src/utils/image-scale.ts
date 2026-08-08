/**
 * Screenshot downscaling.
 *
 * A capture comes off the browser at the display geometry - 1920x1080 here -
 * and every one of them is spent twice: once as bytes across three proxy hops,
 * and once as image tokens in the reader's context. Only the second cost
 * matters at scale, and it is charged by area, not by file size: roughly
 * width x height / 750 tokens. A full-resolution capture is about 2.5k tokens
 * before the model has read a single word of it.
 *
 * Nobody looks at these pictures with human eyes. They exist so an agent can
 * tell what is on a page, and legibility testing against the smallest text in
 * common use (Hacker News, 11px titles over 7px metadata) puts the floor lower
 * than the capture: at a 1024px long edge every glyph on that page survives,
 * at 800px the titles and domains do, and only below ~640px do proper nouns
 * and digits start coming back wrong. So the capture is shrunk before it is
 * handed over, and what would have been 2.5k tokens becomes 400-700.
 *
 * Box-area averaging is used rather than a sharpening filter: minification is
 * exactly the case area-averaging is correct for, and the sharper kernels ring
 * around glyph edges at the ratios involved here.
 *
 * Shrinking is best-effort by construction. A picture that arrived is worth
 * more than a picture at the right size, so every failure path returns the
 * original bytes.
 */

import { PNG } from 'pngjs';

export type ScreenshotDetail = 'low' | 'medium' | 'high' | 'full';

/**
 * Long-edge budget per detail level, in pixels, with the image-token cost of a
 * 16:9 capture at that edge. `full` hands back the capture untouched - note
 * that Anthropic clients resize anything over 1568px themselves, so `full`
 * costs the same as `high` while spending several times the bytes.
 */
export const DETAIL_EDGES: Record<ScreenshotDetail, number> = {
  low: 640, // ~280 tokens - layout, buttons, headings
  medium: 1024, // ~720 tokens - all body text, including 8px metadata
  high: 1568, // ~1700 tokens - the practical ceiling
  full: 0, // no downscale
};

const DETAILS = new Set<string>(Object.keys(DETAIL_EDGES));

/** Schema fragment advertised on every context-capable tool. */
export const SCREENSHOT_DETAIL_SCHEMA = {
  type: 'string',
  enum: ['low', 'medium', 'high', 'full'],
  description:
    "How much resolution any picture in this reply is worth to you. 'low' (640px) reads layout and headings; 'medium' (1024px) reads every glyph on a dense page; 'high' (1568px) is the ceiling worth paying for; 'full' skips the downscale. Costs roughly 280 / 720 / 1700 / 1700 image tokens. Defaults to medium when you asked for a picture and to the smaller auto budget when one was attached for you.",
} as const;

/** Long edge for pictures an agent asked for by name. */
let explicitEdge = DETAIL_EDGES.medium;

/**
 * Long edge for pictures nobody asked for - the one attached to every mutation
 * and the one attached to a refusal. These are situational awareness rather
 * than the answer to a question, they fire far more often, and they are where
 * a long visual-heavy run actually spends its context.
 */
let autoEdge = 800;

export function configureScreenshotScale(opts: { explicit?: number; auto?: number }): void {
  if (Number.isFinite(opts.explicit)) {
    explicitEdge = Math.max(0, Math.floor(opts.explicit as number));
  }
  if (Number.isFinite(opts.auto)) {
    autoEdge = Math.max(0, Math.floor(opts.auto as number));
  }
}

export function screenshotEdgeDefaults(): { explicit: number; auto: number } {
  return { explicit: explicitEdge, auto: autoEdge };
}

/**
 * A per-call `detail` always wins; otherwise the budget depends on whether the
 * caller asked for the picture or simply received one.
 */
export function resolveScreenshotEdge(detail: unknown, kind: 'explicit' | 'auto'): number {
  if (typeof detail === 'string' && DETAILS.has(detail)) {
    return DETAIL_EDGES[detail as ScreenshotDetail];
  }
  if (typeof detail === 'number' && Number.isFinite(detail) && detail > 0) {
    return Math.floor(detail);
  }
  return kind === 'explicit' ? explicitEdge : autoEdge;
}

/**
 * Area-average minification. Each destination pixel is the mean of the source
 * pixels it covers, which is the correct answer for downscaling and cheap
 * enough to stay off the critical path: ~180ms for 1920x994 -> 1024x530, next
 * to a capture that already waits up to 8s for the page to settle.
 */
function boxScale(png: PNG, maxEdge: number): PNG {
  const sw = png.width;
  const sh = png.height;
  const scale = maxEdge / Math.max(sw, sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const out = new PNG({ width: dw, height: dh });
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let idx = (sy * sw + x0) << 2;
        for (let sx = x0; sx < x1; sx++) {
          r += png.data[idx]!;
          g += png.data[idx + 1]!;
          b += png.data[idx + 2]!;
          a += png.data[idx + 3]!;
          n++;
          idx += 4;
        }
      }
      const o = (y * dw + x) << 2;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = a / n;
    }
  }

  return out;
}

/**
 * Shrink a base64 PNG so its long edge fits `maxEdge`. Returns the input
 * unchanged when the picture is already small enough, when downscaling is
 * switched off, or when anything at all goes wrong.
 */
export function shrinkPngBase64(base64Png: string, maxEdge: number): string {
  if (!base64Png || maxEdge <= 0) {
    return base64Png;
  }
  try {
    const png = PNG.sync.read(Buffer.from(base64Png, 'base64'));
    if (Math.max(png.width, png.height) <= maxEdge) {
      return base64Png;
    }
    return PNG.sync.write(boxScale(png, maxEdge), { deflateLevel: 6 }).toString('base64');
  } catch {
    return base64Png;
  }
}

type MaybeImageBlock = { type?: string; data?: unknown; mimeType?: unknown };

/**
 * Rewrite every PNG block in a tool reply. Applied at the response boundary so
 * one rule covers the screenshot tools, the bundle attached to a mutation and
 * the picture attached to a refusal - and so a screenshot written to a file
 * with `saveTo`, which carries no image block and costs no tokens, keeps its
 * full resolution.
 */
export function shrinkImageBlocks<T extends { content?: unknown }>(result: T, maxEdge: number): T {
  if (maxEdge <= 0 || !result || !Array.isArray(result.content)) {
    return result;
  }
  let changed = false;
  const content = (result.content as MaybeImageBlock[]).map((block) => {
    if (!block || block.type !== 'image' || typeof block.data !== 'string') {
      return block;
    }
    if (block.mimeType !== 'image/png') {
      return block;
    }
    const shrunk = shrinkPngBase64(block.data, maxEdge);
    if (shrunk === block.data) {
      return block;
    }
    changed = true;
    return { ...block, data: shrunk };
  });
  return changed ? { ...result, content } : result;
}
