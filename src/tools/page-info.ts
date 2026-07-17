/**
 * page_info — one cheap probe of the current page's ground truth: URL, title,
 * readiness, viewport, pending images, frames, and which containers actually
 * scroll. Answers "why was my screenshot blank / why didn't scroll_page move?"
 * without burning a screenshot.
 */

import { successResponse, errorResponse } from '../utils/response-helpers.js';
import type { McpToolResponse } from '../types/common.js';

export const pageInfoTool = {
  name: 'page_info',
  description:
    'Report page ground truth: final URL, title, readyState, viewport, pending viewport images, body visibility, frame count, and scrollable containers (root vs inner). Cheap text-only diagnostic — use it instead of extra screenshots to check readiness or debug scrolling.',
  inputSchema: { type: 'object', properties: {} },
};

// Runs in the page. Returns a compact JSON string.
const PAGE_INFO_SCRIPT = `
const vh = window.innerHeight, vw = window.innerWidth;
let pending = 0, total = 0;
const imgs = document.images;
for (let i = 0; i < imgs.length; i++) {
  const im = imgs[i];
  const r = im.getBoundingClientRect();
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width === 0) continue;
  total++;
  if (!(im.complete && im.naturalWidth > 0)) pending++;
}
let bodyVisible = false;
if (document.body) {
  const cs = window.getComputedStyle(document.body);
  bodyVisible = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.01;
}
function describe(e) {
  let s = e.tagName ? e.tagName.toLowerCase() : '?';
  if (e.id) s += '#' + e.id;
  if (e.classList && e.classList.length) s += '.' + Array.prototype.slice.call(e.classList, 0, 3).join('.');
  return s;
}
const rootEl = document.scrollingElement || document.documentElement;
const scrollables = [];
const all = document.querySelectorAll('*');
for (let i = 0; i < all.length; i++) {
  const e = all[i];
  const delta = e.scrollHeight - e.clientHeight;
  if (delta < 8 || e.clientHeight < 50) continue;
  const oy = window.getComputedStyle(e).overflowY;
  if (oy !== 'auto' && oy !== 'scroll') continue;
  scrollables.push({ el: describe(e), scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, scrollTop: Math.round(e.scrollTop) });
}
scrollables.sort(function (a, b) { return (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight); });
return JSON.stringify({
  url: location.href,
  title: document.title,
  readyState: document.readyState,
  viewport: { w: vw, h: vh },
  bodyVisible: bodyVisible,
  imgsPendingViewport: pending,
  imgsViewport: total,
  frames: window.frames.length,
  rootScrollable: rootEl.scrollHeight > vh + 2,
  docScrollHeight: rootEl.scrollHeight,
  scrollY: Math.round(window.scrollY),
  scrollContainers: scrollables.slice(0, 5)
});
`;

export async function handlePageInfo(_args: unknown): Promise<McpToolResponse> {
  try {
    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();
    const driver = firefox.getDriver();
    if (!driver) throw new Error('WebDriver not available');

    await driver.manage().setTimeouts({ script: 5000 });
    const raw = await driver.executeScript(PAGE_INFO_SCRIPT);
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const response = successResponse(text);
    // Native structured result — escape-free for clients that support it
    try {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        response.structuredContent = parsed as Record<string, unknown>;
      }
    } catch {
      // Text fallback only
    }
    return response;
  } catch (error) {
    return errorResponse(error as Error);
  }
}
