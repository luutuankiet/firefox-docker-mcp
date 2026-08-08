/**
 * Page utility tools (dialogs, history, viewport)
 */

import { successResponse, errorResponse } from '../utils/response-helpers.js';
import { isBiDiUnavailable } from '../firefox/bidi-ops.js';
import { tenancy, tabName } from '../tenancy.js';
import type { McpToolResponse } from '../types/common.js';

/**
 * Named geometries, so an agent asking for "mobile" does not have to remember
 * what an iPhone measures. Sizes are CSS pixels, which is what a page's media
 * queries actually read.
 *
 * Pixel ratio is deliberately absent here. It changes nothing about layout -
 * only which assets a page picks - and it multiplies every captured pixel, so
 * it is worth asking for rather than inheriting.
 */
export const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  'phone-small': { width: 360, height: 740 },
  phone: { width: 390, height: 844 },
  'phone-large': { width: 430, height: 932 },
  tablet: { width: 820, height: 1180 },
  laptop: { width: 1440, height: 900 },
  desktop: { width: 1920, height: 1080 },
};

// Tool definitions - Dialogs
export const acceptDialogTool = {
  name: 'accept_dialog',
  description: 'Accept browser dialog. Provide promptText for prompts.',
  inputSchema: {
    type: 'object',
    properties: {
      promptText: {
        type: 'string',
        description: 'Text for prompt dialogs',
      },
    },
  },
};

export const dismissDialogTool = {
  name: 'dismiss_dialog',
  description: 'Dismiss browser dialog.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

// Tool definitions - History
export const navigateHistoryTool = {
  name: 'navigate_history',
  description: 'Navigate history back/forward. UIDs become stale.',
  inputSchema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['back', 'forward'],
        description: 'back or forward',
      },
    },
    required: ['direction'],
  },
};

// Tool definitions - Viewport
export const setViewportSizeTool = {
  name: 'set_viewport_size',
  description:
    'Resize your tab. Pass a preset (phone, tablet, desktop...) or width+height. Affects your tab alone, survives navigation, and stays until you reset it.',
  inputSchema: {
    type: 'object',
    properties: {
      preset: {
        type: 'string',
        enum: Object.keys(VIEWPORT_PRESETS),
        description:
          'Named size instead of raw numbers: phone-small 360x740, phone 390x844, phone-large 430x932, tablet 820x1180, laptop 1440x900, desktop 1920x1080.',
      },
      width: {
        type: 'number',
        description: 'Width in CSS pixels. Ignored when preset is given.',
      },
      height: {
        type: 'number',
        description: 'Height in CSS pixels. Ignored when preset is given.',
      },
      devicePixelRatio: {
        type: 'number',
        description:
          'Pretend the screen is this dense - 2 or 3 makes a page choose retina assets, as a real phone would. Layout does not change. Costs capture time, since it multiplies the pixels behind the same page.',
      },
      reset: {
        type: 'boolean',
        description: 'Hand the tab back to the window size and forget any override.',
      },
      scope: {
        type: 'string',
        enum: ['tab', 'window'],
        description:
          "'tab' (default) resizes only your own tab and leaves everyone else's alone. 'window' resizes the browser window, which every other tab and every person watching over VNC shares - use it only when the window itself is the point.",
      },
    },
  },
};

// Handlers - Dialogs
export async function handleAcceptDialog(args: unknown): Promise<McpToolResponse> {
  try {
    const { promptText } = (args as { promptText?: string }) || {};

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    try {
      await firefox.acceptDialog(promptText);
      return successResponse(promptText ? `✅ Accepted: "${promptText}"` : '✅ Accepted');
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Concise error for no active dialog
      if (errorMsg.includes('no such alert') || errorMsg.includes('No dialog')) {
        throw new Error('No active dialog');
      }

      throw error;
    }
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleDismissDialog(_args: unknown): Promise<McpToolResponse> {
  try {
    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    try {
      await firefox.dismissDialog();
      return successResponse('✅ Dismissed');
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Concise error for no active dialog
      if (errorMsg.includes('no such alert') || errorMsg.includes('No dialog')) {
        throw new Error('No active dialog');
      }

      throw error;
    }
  } catch (error) {
    return errorResponse(error as Error);
  }
}

// Handlers - History
export async function handleNavigateHistory(args: unknown): Promise<McpToolResponse> {
  try {
    const { direction } = args as { direction: 'back' | 'forward' };

    if (!direction || (direction !== 'back' && direction !== 'forward')) {
      throw new Error('direction parameter is required and must be "back" or "forward"');
    }

    const { getFirefox } = await import('../index.js');
    const { ensureUnloadPromptsDisabled } = await import('../utils/unload-guard.js');
    const { withNavigationWatchdog, getNavTimeoutMs } = await import('../utils/nav-watchdog.js');
    const firefox = await getFirefox();

    await ensureUnloadPromptsDisabled(firefox);
    await withNavigationWatchdog(`navigate_history ${direction}`, getNavTimeoutMs(), () =>
      direction === 'back' ? firefox.navigateBack() : firefox.navigateForward()
    );

    return successResponse(`✅ ${direction}`);
  } catch (error) {
    return errorResponse(error as Error);
  }
}

// Handlers - Viewport
/**
 * Resize one tab rather than the whole browser.
 *
 * The classic WebDriver call resizes the OS window, which on a shared machine
 * means one agent laying out a phone screen reshapes every other agent's page
 * and the window a person is watching over VNC. The tab-scoped path names its
 * own tab, so a mobile layout stays where it was asked for.
 */
export async function handleSetViewportSize(args: unknown): Promise<McpToolResponse> {
  try {
    const {
      width,
      height,
      preset,
      devicePixelRatio,
      reset,
      tab,
      scope,
    } = (args ?? {}) as {
      width?: number;
      height?: number;
      preset?: string;
      devicePixelRatio?: number;
      reset?: boolean;
      tab?: string;
      scope?: string;
    };

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();
    const perTab = Boolean(tab) && scope !== 'window';

    if (reset) {
      if (!perTab) {
        throw new Error(
          'reset applies to a tab override; the window has no size to fall back to'
        );
      }
      // Null rather than omitted: leaving the ratio out keeps whatever density
      // was last asked for, which is a reset that does not reset.
      await firefox.setTabViewport(tab!, null, null);
      tenancy.setViewport(tab!, null);
      return successResponse(`✅ ${tabName(tab!)} back to the window size`);
    }

    let target: { width: number; height: number };
    if (typeof preset === 'string') {
      const known = VIEWPORT_PRESETS[preset];
      if (!known) {
        throw new Error(
          `unknown preset "${preset}"; try one of ${Object.keys(VIEWPORT_PRESETS).join(', ')}`
        );
      }
      target = known;
    } else if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
      target = { width: Math.round(width), height: Math.round(height) };
    } else {
      throw new Error(
        `give either preset (${Object.keys(VIEWPORT_PRESETS).join(', ')}) or a positive width and height`
      );
    }

    const ratio =
      typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : undefined;
    const density = ratio && ratio !== 1 ? ` at ${ratio}x density` : '';

    if (perTab) {
      try {
        // Always stated, so a call that says nothing about density means
        // native density rather than whatever the last call happened to set.
        await firefox.setTabViewport(tab!, target, ratio ?? null);
        tenancy.setViewport(tab!, ratio ? { ...target, devicePixelRatio: ratio } : { ...target });
        return successResponse(
          `✅ ${tabName(tab!)} is ${target.width}x${target.height}${density} - this tab only, and it stays that way until you reset it`
        );
      } catch (bidiError) {
        // An older browser without BiDi still deserves a working tool, even if
        // the blast radius is wider than the caller asked for.
        if (!isBiDiUnavailable(bidiError)) {
          throw bidiError;
        }
      }
    }

    await firefox.setViewportSize(target.width, target.height);

    return successResponse(
      `✅ ${target.width}x${target.height} (whole window - every tab and the VNC view moved)`
    );
  } catch (error) {
    return errorResponse(error as Error);
  }
}
