/**
 * Screenshot tools for visual capture
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import { successResponse, errorResponse } from '../utils/response-helpers.js';
import { handleUidError } from '../utils/uid-helpers.js';
import { isBiDiUnavailable, type CaptureFormat, type CaptureOptions } from '../firefox/bidi-ops.js';
import { SCREENSHOT_DIR, assetTtlMinutes } from '../utils/asset-janitor.js';
import type { McpToolResponse } from '../types/common.js';

const SAVE_TO_SCHEMA = {
  type: 'string',
  description:
    "Write the screenshot to a file on the server instead of returning the image. Only the file name is used: the copy goes into the server's own screenshots folder, inside its container, and is deleted after a while (usually 60 minutes). The reply gives the real path. No image is returned when this is set.",
} as const;

const FORMAT_SCHEMA = {
  type: 'string',
  enum: ['png', 'jpeg'],
  description: "Image encoding. 'png' (default) is exact; 'jpeg' is smaller for photos and long pages.",
} as const;

const QUALITY_SCHEMA = {
  type: 'number',
  minimum: 0,
  maximum: 1,
  description: 'JPEG quality from 0 to 1, default 0.8. Ignored for PNG.',
} as const;

const SELECTOR_SCHEMA = {
  type: 'string',
  description:
    'CSS selector; captures the first matching element. The reply says so when more than one matched.',
} as const;

// Tool definitions
export const screenshotPageTool = {
  name: 'screenshot_page',
  description:
    'Capture a tab as an image. Default is the visible viewport as PNG. fullPage, clip and selector (pick at most one) capture the whole document, a box, or one element; format picks PNG or JPEG.',
  inputSchema: {
    type: 'object',
    properties: {
      fullPage: {
        type: 'boolean',
        description:
          'Capture the whole document, not just the viewport. Pages taller than Firefox can capture in one picture (32767 device pixels) are cut, and the reply says where and how to get the rest.',
      },
      clip: {
        type: 'object',
        description: 'Capture this box, in CSS pixels measured from the top-left of the document.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['x', 'y', 'width', 'height'],
      },
      selector: SELECTOR_SCHEMA,
      format: FORMAT_SCHEMA,
      quality: QUALITY_SCHEMA,
      saveTo: SAVE_TO_SCHEMA,
    },
  },
};

export const screenshotByUidTool = {
  name: 'screenshot_by_uid',
  description:
    'Capture one element as an image, named by a snapshot UID or by a CSS selector (exactly one of the two).',
  inputSchema: {
    type: 'object',
    properties: {
      uid: {
        type: 'string',
        description: 'Element UID from snapshot',
      },
      selector: SELECTOR_SCHEMA,
      format: FORMAT_SCHEMA,
      quality: QUALITY_SCHEMA,
      saveTo: SAVE_TO_SCHEMA,
    },
  },
};

// ============================================================================
// Capture limits
// ============================================================================

/**
 * Firefox refuses or shrinks a single capture past these, both in device
 * pixels: one canvas side, and one canvas area. The values are the ones the
 * remote agent's capture code checks against.
 */
const MAX_CANVAS_SIDE = 32767;
const MAX_CANVAS_AREA = 472907776;

type Box = { x: number; y: number; width: number; height: number };

/**
 * Fit a document box inside what one capture can hold. Returns the box to ask
 * for, plus a note for the caller when anything was cut - the cut is silent
 * otherwise, and a picture that quietly ends halfway down a page reads as a
 * page that ends there.
 */
function clampBox(box: Box, devicePixelRatio: number, what: string): { box: Box; note?: string } {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const maxSide = Math.floor(MAX_CANVAS_SIDE / dpr);
  let width = Math.min(box.width, maxSide);
  let height = Math.min(box.height, maxSide);
  const maxArea = MAX_CANVAS_AREA / (dpr * dpr);
  if (width * height > maxArea) {
    height = Math.max(1, Math.floor(maxArea / width));
  }
  if (width === box.width && height === box.height) {
    return { box };
  }

  const parts: string[] = [];
  if (height < box.height) {
    const cutY = box.y + height;
    parts.push(
      `${what} is ${box.height}px tall, more than Firefox can capture in one picture, so this capture stops at y=${cutY}. ` +
        `For the rest, call screenshot_page with clip {x: ${box.x}, y: ${cutY}, width: ${width}, height: ${box.y + box.height - cutY}}.`
    );
  }
  if (width < box.width) {
    const cutX = box.x + width;
    parts.push(
      `${what} is ${box.width}px wide, so this capture stops at x=${cutX}. ` +
        `For the rest, call screenshot_page with clip {x: ${cutX}, y: ${box.y}, width: ${box.x + box.width - cutX}, height: ${height}}.`
    );
  }
  return { box: { x: box.x, y: box.y, width, height }, note: parts.join(' ') };
}

// ============================================================================
// Argument parsing
// ============================================================================

type ImageFormat = 'png' | 'jpeg';

interface FormatChoice {
  format: ImageFormat;
  mimeType: string;
  /** Passed to BiDi; absent for the default PNG so the request is unchanged. */
  bidi?: CaptureFormat;
}

function parseFormat(format: unknown, quality: unknown): FormatChoice {
  if (format === undefined || format === null || format === 'png') {
    return { format: 'png', mimeType: 'image/png' };
  }
  if (format !== 'jpeg') {
    throw new Error(`format must be 'png' or 'jpeg', got ${JSON.stringify(format)}`);
  }
  let q = 0.8;
  if (quality !== undefined && quality !== null) {
    if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1) {
      throw new Error(`quality must be a number from 0 to 1, got ${JSON.stringify(quality)}`);
    }
    q = quality;
  }
  return { format: 'jpeg', mimeType: 'image/jpeg', bidi: { type: 'image/jpeg', quality: q } };
}

function parseClip(clip: unknown): Box {
  const c = clip as Partial<Box> | null;
  const nums = [c?.x, c?.y, c?.width, c?.height];
  if (!c || typeof c !== 'object' || nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error('clip needs numeric x, y, width and height');
  }
  if (c.width! <= 0 || c.height! <= 0) {
    throw new Error('clip width and height must be greater than 0');
  }
  if (c.x! < 0 || c.y! < 0) {
    throw new Error('clip x and y must be 0 or more');
  }
  return { x: c.x!, y: c.y!, width: c.width!, height: c.height! };
}

// ============================================================================
// Shared pieces
// ============================================================================

type Firefox = Awaited<ReturnType<typeof import('../index.js').getFirefox>>;

/**
 * The tab a BiDi-only capture goes to. The dispatcher hands every call the tab
 * it resolved - named, owned, or the one in front - so this is almost always
 * `tab`. The focused context covers a call that arrived before any tab was
 * resolved. Either way the capture is addressed by context, so nothing is
 * raised and the person's view does not move.
 */
function bidiTarget(firefox: Firefox, tab: string | undefined, option: string): string {
  const target = tab ?? firefox.getCurrentContextId();
  if (!target) {
    throw new Error(`${option} needs a tab to capture, and none could be resolved. Pass tab.`);
  }
  return target;
}

/**
 * Run a BiDi-only capture. These options have no honest classic fallback: the
 * classic capture can only photograph the viewport of the focused tab, so it
 * would quietly answer a different question. A failed channel becomes an error
 * that says so.
 */
async function bidiOnly<T>(option: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isBiDiUnavailable(error)) {
      throw new Error(
        `${option} needs WebDriver BiDi, which is not working on this connection (${
          (error as Error).message
        }). No viewport-only capture was taken in its place.`
      );
    }
    throw error;
  }
}

async function resolveSelector(
  firefox: Firefox,
  tab: string,
  selector: string
): Promise<{ sharedId: string; note: string | undefined }> {
  const ids = await firefox.locateCssInTab(tab, selector, 2);
  if (ids.length === 0) {
    throw new Error(`No element matches selector ${JSON.stringify(selector)}`);
  }
  return {
    sharedId: ids[0]!,
    note:
      ids.length > 1
        ? `Selector ${JSON.stringify(selector)} matched more than one element; captured the first.`
        : undefined,
  };
}

/** A file name the server is willing to write: base name only, safe characters, our extension. */
function safeFileName(saveTo: string, format: ImageFormat): string {
  const base = basename(saveTo).replace(/[^A-Za-z0-9._-]/g, '');
  const stem = base.slice(0, base.length - extname(base).length).replace(/^\.+/, '');
  const ext = format === 'jpeg' ? '.jpg' : '.png';
  return `${stem || 'screenshot'}${ext}`;
}

/**
 * Write the capture into the server's own screenshots folder and say where.
 * Whatever directory the caller named is not used: it was usually a path on
 * the caller's machine, and the server only ever wrote it inside its own
 * container, where nothing read it and nothing deleted it.
 */
async function saveScreenshot(
  base64: string,
  saveTo: string,
  choice: FormatChoice,
  notes: string[]
): Promise<McpToolResponse> {
  const buffer = Buffer.from(base64, 'base64');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  const path = join(SCREENSHOT_DIR, `${stamp}-${safeFileName(saveTo, choice.format)}`);
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await writeFile(path, buffer);

  const ttl = assetTtlMinutes();
  const lines = [
    Number.isFinite(ttl) && ttl > 0
      ? `Screenshot saved on the server at ${path} (${(buffer.length / 1024).toFixed(1)} KB). This copy is inside the server's container and is deleted after ${ttl} minutes.`
      : `Screenshot saved on the server at ${path} (${(buffer.length / 1024).toFixed(1)} KB). This copy is inside the server's container; cleanup is switched off on this server.`,
  ];
  if (resolve(saveTo) !== path) {
    lines.push(`The path you gave (${saveTo}) was not used: the server writes only into its own folder.`);
  }
  return successResponse([...lines, ...notes].join('\n'));
}

function imageResponse(base64: string, mimeType: string, notes: string[]): McpToolResponse {
  return {
    content: [
      ...(notes.length > 0 ? [{ type: 'text' as const, text: notes.join('\n') }] : []),
      { type: 'image', data: base64, mimeType },
    ],
  };
}

function finish(
  base64: string | null,
  choice: FormatChoice,
  saveTo: string | undefined,
  notes: string[]
): Promise<McpToolResponse> | McpToolResponse {
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('Invalid screenshot data');
  }
  if (saveTo) {
    return saveScreenshot(base64, saveTo, choice, notes);
  }
  return imageResponse(base64, choice.mimeType, notes);
}

// ============================================================================
// Handlers
// ============================================================================

export async function handleScreenshotPage(args: unknown): Promise<McpToolResponse> {
  try {
    const { saveTo, tab, fullPage, clip, selector, format, quality } = (args ?? {}) as {
      saveTo?: string;
      tab?: string;
      fullPage?: boolean;
      clip?: unknown;
      selector?: string;
      format?: unknown;
      quality?: unknown;
    };

    const regions = [
      fullPage ? 'fullPage' : null,
      clip !== undefined && clip !== null ? 'clip' : null,
      selector !== undefined && selector !== null ? 'selector' : null,
    ].filter(Boolean);
    if (regions.length > 1) {
      throw new Error(`Pass at most one of fullPage, clip and selector (got ${regions.join(', ')})`);
    }
    if (selector !== undefined && selector !== null && (typeof selector !== 'string' || !selector)) {
      throw new Error('selector must be a non-empty CSS selector string');
    }
    const choice = parseFormat(format, quality);

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    // Anything past a plain PNG of the viewport is BiDi-only.
    if (regions.length > 0 || choice.bidi) {
      const option = regions[0] ?? `format '${choice.format}'`;
      const notes: string[] = [];
      const target = bidiTarget(firefox, tab, option);

      const base64 = await bidiOnly(option, async () => {
        const options: CaptureOptions = choice.bidi ? { format: choice.bidi } : {};
        if (fullPage) {
          const geometry = await firefox.documentGeometryInTab(target);
          const whole = { x: 0, y: 0, width: geometry.width, height: geometry.height };
          const { box, note } = clampBox(whole, geometry.devicePixelRatio, 'The page');
          options.origin = 'document';
          if (note) {
            notes.push(note);
            options.clip = { type: 'box', ...box };
          }
        } else if (clip !== undefined && clip !== null) {
          const asked = parseClip(clip);
          const geometry = await firefox.documentGeometryInTab(target);
          const { box, note } = clampBox(asked, geometry.devicePixelRatio, 'The clip');
          if (note) {
            notes.push(note);
          }
          options.origin = 'document';
          options.clip = { type: 'box', ...box };
        } else if (selector) {
          const found = await resolveSelector(firefox, target, selector);
          if (found.note) {
            notes.push(found.note);
          }
          options.origin = 'document';
          options.clip = { type: 'element', element: { sharedId: found.sharedId } };
        }
        return await firefox.screenshotTab(target, options);
      });

      return await finish(base64, choice, saveTo, notes);
    }

    // Capturing the tab by name avoids raising it. Firefox throttles rendering
    // off-screen, so a background tab can come back blank - the focused capture
    // below is the honest answer when that happens.
    let base64Png: string | null = null;
    if (tab) {
      try {
        base64Png = await firefox.screenshotTab(tab);
      } catch {
        base64Png = null;
      }
    }
    if (!base64Png) {
      // The classic capture photographs whatever is on screen, so the intended
      // tab has to be raised first or the caller gets someone else's page.
      if (tab) {
        try {
          await firefox.selectTabById(tab);
        } catch {
          // A tab that vanished mid-call: capture whatever is there instead.
        }
      }
      base64Png = await firefox.takeScreenshotPage();
    }

    return await finish(base64Png, choice, saveTo, []);
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleScreenshotByUid(args: unknown): Promise<McpToolResponse> {
  try {
    const { uid, selector, saveTo, tab, format, quality } = (args ?? {}) as {
      uid?: string;
      selector?: string;
      saveTo?: string;
      tab?: string;
      format?: unknown;
      quality?: unknown;
    };

    const hasUid = typeof uid === 'string' && uid.length > 0;
    const hasSelector = typeof selector === 'string' && selector.length > 0;
    if (hasUid === hasSelector) {
      throw new Error('Pass exactly one of uid and selector');
    }
    const choice = parseFormat(format, quality);

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    if (hasSelector) {
      const notes: string[] = [];
      const target = bidiTarget(firefox, tab, 'selector');
      const base64 = await bidiOnly('selector', async () => {
        const found = await resolveSelector(firefox, target, selector!);
        if (found.note) {
          notes.push(found.note);
        }
        return await firefox.screenshotElementInTab(target, found.sharedId, choice.bidi);
      });
      return await finish(base64, choice, saveTo, notes);
    }

    try {
      // JPEG is BiDi-only: the classic element capture is PNG and nothing else.
      if (choice.bidi) {
        const option = `format '${choice.format}'`;
        const target = bidiTarget(firefox, tab, option);
        const base64 = await bidiOnly(option, () =>
          firefox.screenshotUidInTab(target, uid!, choice.bidi)
        );
        return await finish(base64, choice, saveTo, []);
      }

      // Capturing the element in a named tab leaves the foreground alone. The
      // classic capture below photographs whatever is on screen, so the tab has
      // to be raised first or the picture is of someone else's page.
      let base64Png: string | null = null;
      if (tab) {
        try {
          base64Png = await firefox.screenshotUidInTab(tab, uid!);
        } catch (error) {
          if (!isBiDiUnavailable(error)) {
            throw error;
          }
          await firefox.selectTabById(tab);
        }
      }
      if (!base64Png) {
        base64Png = await firefox.takeScreenshotByUid(uid!);
      }

      return await finish(base64Png, choice, saveTo, []);
    } catch (error) {
      throw handleUidError(error as Error, uid!);
    }
  } catch (error) {
    return errorResponse(error as Error);
  }
}
