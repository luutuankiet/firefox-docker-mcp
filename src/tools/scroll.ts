/**
 * scroll_page — scroll the viewport or an element into view. Registered as a
 * mutation tool so the auto-screenshot middleware captures the post-scroll state.
 * Fires scroll listeners / lazy-load (covers swipe intent without synthetic touch).
 */

import { successResponse, errorResponse } from '../utils/response-helpers.js';
import type { McpToolResponse } from '../types/common.js';

export const scrollPageTool = {
  name: 'scroll_page',
  description:
    'Scroll the page or an element into view. to: top|bottom|element (element needs uid or selector); or by:{x,y} for a relative scroll (overrides to). Fires scroll/lazy-load listeners. The auto-screenshot shows the result.',
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        enum: ['top', 'bottom', 'element'],
        description: 'Scroll target. "element" requires uid or selector.',
      },
      uid: { type: 'string', description: 'Element UID from snapshot (for to=element).' },
      selector: { type: 'string', description: 'CSS selector (for to=element; alternative to uid).' },
      by: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        description: 'Relative scroll offset in px. Applied when set (overrides "to").',
      },
      behavior: {
        type: 'string',
        enum: ['instant', 'smooth'],
        description: 'Scroll behavior (default instant).',
      },
    },
  },
};

const SCROLL_SCRIPT = `
const p = arguments[0] || {};
const el = arguments[1] || null;
const behavior = p.behavior || 'instant';
if (p.by && (typeof p.by.x === 'number' || typeof p.by.y === 'number')) {
  window.scrollBy({ left: p.by.x || 0, top: p.by.y || 0, behavior: behavior });
} else if (el) {
  el.scrollIntoView({ behavior: behavior, block: 'center', inline: 'center' });
} else if (p.to === 'bottom') {
  window.scrollTo({ left: 0, top: document.documentElement.scrollHeight, behavior: behavior });
} else if (p.to === 'top') {
  window.scrollTo({ left: 0, top: 0, behavior: behavior });
}
const doc = document.documentElement;
const scrollY = window.scrollY;
const scrollHeight = doc.scrollHeight;
const viewportH = window.innerHeight;
return JSON.stringify({
  scrollY: Math.round(scrollY),
  scrollHeight: scrollHeight,
  viewportH: viewportH,
  atBottom: (scrollY + viewportH) >= (scrollHeight - 2),
  atTop: scrollY <= 1
});
`;

export async function handleScrollPage(args: unknown): Promise<McpToolResponse> {
  try {
    const params = (args ?? {}) as {
      to?: string;
      uid?: string;
      selector?: string;
      by?: { x?: number; y?: number };
      behavior?: string;
    };

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();
    const driver = firefox.getDriver();
    if (!driver) throw new Error('WebDriver not available');

    let element: unknown = null;
    if (!params.by && params.to === 'element') {
      if (params.uid) {
        try {
          element = await firefox.resolveUidToElement(params.uid);
        } catch (error) {
          const msg = (error as Error).message;
          if (msg.includes('stale') || msg.includes('Snapshot') || msg.includes('UID')) {
            throw new Error(
              `UID "${params.uid}" is invalid or from an old snapshot. Call take_snapshot for fresh UIDs.`
            );
          }
          throw error;
        }
      } else if (params.selector) {
        element = await driver.executeScript(
          'return document.querySelector(arguments[0]);',
          params.selector
        );
        if (!element) throw new Error(`No element matched selector "${params.selector}".`);
      } else {
        throw new Error('to=element requires a uid or selector.');
      }
    }

    await driver.manage().setTimeouts({ script: 5000 });
    const raw = (await driver.executeScript(SCROLL_SCRIPT, params, element)) as string;

    let summary: string;
    try {
      const s = JSON.parse(raw);
      const flags = `${s.atBottom ? ' [at bottom]' : ''}${s.atTop ? ' [at top]' : ''}`;
      summary =
        `✅ scrolled — scrollY=${s.scrollY}/${s.scrollHeight}px viewport=${s.viewportH}px${flags}\n` +
        '```json\n' + JSON.stringify(s, null, 2) + '\n```';
    } catch {
      summary = raw;
    }
    return successResponse(summary);
  } catch (error) {
    return errorResponse(error as Error);
  }
}
