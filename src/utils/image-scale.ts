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
import jpeg from 'jpeg-js';

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

/** Decoded pixels, four bytes per pixel. Both `pngjs` and `jpeg-js` produce this. */
interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * The size a picture should come back at, or null when it already fits.
 *
 * The long edge is fitted to the budget, except for pictures more than twice
 * as tall as they are wide - a full-page capture, typically. Fitting the long
 * edge of a 1920x15000 page to 1024 leaves it ~131px wide, which nobody can
 * read, so those fit their width instead and let the height follow. Viewport
 * captures and the pictures attached to mutations are never that shape, so
 * they keep the long-edge rule.
 *
 * Whatever the rule, no side leaves longer than MAX_SIDE: the Anthropic API
 * rejects an image over 8000px on either side, which fails the whole reply.
 */
const MAX_SIDE = 8000;

function targetSize(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } | null {
  const tall = height > width * 2;
  const governing = tall ? width : Math.max(width, height);
  let scale = governing > maxEdge ? maxEdge / governing : 1;
  const longest = Math.max(width, height) * scale;
  if (longest > MAX_SIDE) {
    scale = MAX_SIDE / Math.max(width, height);
  }
  if (scale >= 1) {
    return null;
  }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Area-average minification. Each destination pixel is the mean of the source
 * pixels it covers, which is the correct answer for downscaling and cheap
 * enough to stay off the critical path: ~180ms for 1920x994 -> 1024x530, next
 * to a capture that already waits up to 8s for the page to settle.
 */
function boxScale(src: Rgba, dw: number, dh: number): Rgba {
  const sw = src.width;
  const sh = src.height;
  const data = new Uint8Array(dw * dh * 4);
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
          r += src.data[idx]!;
          g += src.data[idx + 1]!;
          b += src.data[idx + 2]!;
          a += src.data[idx + 3]!;
          n++;
          idx += 4;
        }
      }
      const o = (y * dw + x) << 2;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = a / n;
    }
  }

  return { width: dw, height: dh, data };
}

/**
 * Shrink a base64 PNG to fit `maxEdge` (see `targetSize` for which edge).
 * Returns the input unchanged when the picture is already small enough, when
 * downscaling is switched off, or when anything at all goes wrong.
 */
export function shrinkPngBase64(base64Png: string, maxEdge: number): string {
  if (!base64Png || maxEdge <= 0) {
    return base64Png;
  }
  try {
    const png = PNG.sync.read(Buffer.from(base64Png, 'base64'));
    const size = targetSize(png.width, png.height, maxEdge);
    if (!size) {
      return base64Png;
    }
    const scaled = boxScale(png, size.width, size.height);
    const out = new PNG({ width: scaled.width, height: scaled.height });
    out.data = Buffer.from(scaled.data.buffer, scaled.data.byteOffset, scaled.data.byteLength);
    return PNG.sync.write(out, { deflateLevel: 6 }).toString('base64');
  } catch {
    return base64Png;
  }
}

/** Quality the shrunk JPEG is re-encoded at; the capture's own setting is lost on decode. */
const JPEG_REENCODE_QUALITY = 85;

/**
 * Shrink a base64 JPEG the same way, re-encoding at quality 85. Same rule as
 * the PNG path: any failure hands back the original.
 */
export function shrinkJpegBase64(base64Jpeg: string, maxEdge: number): string {
  if (!base64Jpeg || maxEdge <= 0) {
    return base64Jpeg;
  }
  try {
    const decoded = jpeg.decode(Buffer.from(base64Jpeg, 'base64'), {
      useTArray: true,
      formatAsRGBA: true,
      // A full-page capture can reach 1920x32767 (~63 MP); the library's
      // defaults (100 MP, 512 MB) are close enough to that to raise them.
      maxResolutionInMP: 200,
      maxMemoryUsageInMB: 1024,
    });
    const size = targetSize(decoded.width, decoded.height, maxEdge);
    if (!size) {
      return base64Jpeg;
    }
    const scaled = boxScale(decoded, size.width, size.height);
    return jpeg.encode(scaled, JPEG_REENCODE_QUALITY).data.toString('base64');
  } catch {
    return base64Jpeg;
  }
}

type MaybeImageBlock = { type?: string; data?: unknown; mimeType?: unknown };

/**
 * Rewrite every PNG and JPEG block in a tool reply. Applied at the response boundary so
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
    let shrunk: string;
    if (block.mimeType === 'image/png') {
      shrunk = shrinkPngBase64(block.data, maxEdge);
    } else if (block.mimeType === 'image/jpeg') {
      shrunk = shrinkJpegBase64(block.data, maxEdge);
    } else {
      return block;
    }
    if (shrunk === block.data) {
      return block;
    }
    changed = true;
    return { ...block, data: shrunk };
  });
  return changed ? { ...result, content } : result;
}
