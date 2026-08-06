/**
 * Screenshot tools for visual capture
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { successResponse, errorResponse } from '../utils/response-helpers.js';
import { handleUidError } from '../utils/uid-helpers.js';
import { isBiDiUnavailable } from '../firefox/bidi-ops.js';
import type { McpToolResponse } from '../types/common.js';

const SAVE_TO_SCHEMA = {
  type: 'string',
  description:
    'Optional file path to save the screenshot to instead of returning it as image data in the response.',
} as const;

// Tool definitions
export const screenshotPageTool = {
  name: 'screenshot_page',
  description: 'Capture page screenshot as base64 PNG.',
  inputSchema: {
    type: 'object',
    properties: {
      saveTo: SAVE_TO_SCHEMA,
    },
  },
};

export const screenshotByUidTool = {
  name: 'screenshot_by_uid',
  description: 'Capture element screenshot by UID as base64 PNG.',
  inputSchema: {
    type: 'object',
    properties: {
      uid: {
        type: 'string',
        description: 'Element UID from snapshot',
      },
      saveTo: SAVE_TO_SCHEMA,
    },
    required: ['uid'],
  },
};

/**
 * Save screenshot to file and return text response with path.
 */
async function saveScreenshot(base64Png: string, saveTo: string): Promise<McpToolResponse> {
  const buffer = Buffer.from(base64Png, 'base64');
  const resolvedPath = resolve(saveTo);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, buffer);

  return successResponse(
    `Screenshot saved to: ${resolvedPath} (${(buffer.length / 1024).toFixed(1)}KB)`
  );
}

/**
 * Return screenshot as native image content for GUI MCP clients.
 */
function imageResponse(base64Png: string): McpToolResponse {
  return {
    content: [
      {
        type: 'image',
        data: base64Png,
        mimeType: 'image/png',
      },
    ],
  };
}

// Handlers
export async function handleScreenshotPage(args: unknown): Promise<McpToolResponse> {
  try {
    const { saveTo, tab } = (args ?? {}) as { saveTo?: string; tab?: string };

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

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

    if (!base64Png || typeof base64Png !== 'string') {
      throw new Error('Invalid screenshot data');
    }

    if (saveTo) {
      return await saveScreenshot(base64Png, saveTo);
    }

    return imageResponse(base64Png);
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleScreenshotByUid(args: unknown): Promise<McpToolResponse> {
  try {
    const { uid, saveTo, tab } = args as { uid: string; saveTo?: string; tab?: string };

    if (!uid || typeof uid !== 'string') {
      throw new Error('uid required');
    }

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    try {
      // Capturing the element in a named tab leaves the foreground alone. The
      // classic capture below photographs whatever is on screen, so the tab has
      // to be raised first or the picture is of someone else's page.
      let base64Png: string | null = null;
      if (tab) {
        try {
          base64Png = await firefox.screenshotUidInTab(tab, uid);
        } catch (error) {
          if (!isBiDiUnavailable(error)) {
            throw error;
          }
          await firefox.selectTabById(tab);
        }
      }
      if (!base64Png) {
        base64Png = await firefox.takeScreenshotByUid(uid);
      }

      if (!base64Png || typeof base64Png !== 'string') {
        throw new Error('Invalid screenshot data');
      }

      if (saveTo) {
        return await saveScreenshot(base64Png, saveTo);
      }

      return imageResponse(base64Png);
    } catch (error) {
      throw handleUidError(error as Error, uid);
    }
  } catch (error) {
    return errorResponse(error as Error);
  }
}
