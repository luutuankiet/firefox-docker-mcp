/**
 * Visual readiness probe for the auto-screenshot middleware.
 * Polls the page until it looks paint-ready: document loaded, body visible
 * (FOUC guard for pre-hydration app shells), and every image intersecting the
 * viewport decoded (below-fold lazy-load images are deliberately ignored so
 * they cannot stall the wait). On timeout the caller screenshots anyway and
 * annotates what was still pending.
 */

interface ReadyProbe {
  readyState: string;
  bodyVisible: boolean;
  imgsPending: number;
  imgsViewport: number;
}

interface ScriptDriver {
  executeScript(script: string): Promise<unknown>;
}

const POLL_INTERVAL_MS = 250;

// Runs in the page. Returns a JSON string.
const READY_PROBE_SCRIPT = `
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
return JSON.stringify({
  readyState: document.readyState,
  bodyVisible: bodyVisible,
  imgsPending: pending,
  imgsViewport: total
});
`;

/**
 * Wait until the page is visually ready or timeoutMs elapses.
 * Returns null when ready (or when the wait is disabled with timeoutMs <= 0);
 * returns an annotation string describing what was still pending on timeout.
 */
export async function waitForVisualReady(
  driver: ScriptDriver | null | undefined,
  timeoutMs: number
): Promise<string | null> {
  if (!driver || timeoutMs <= 0) return null;
  const start = Date.now();
  let last: ReadyProbe | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await driver.executeScript(READY_PROBE_SCRIPT);
      if (typeof raw === 'string') last = JSON.parse(raw) as ReadyProbe;
      if (last && last.readyState === 'complete' && last.bodyVisible && last.imgsPending === 0) {
        // Settle two animation frames so the capture sees the painted state
        try {
          await driver.executeScript(
            'return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'
          );
        } catch {
          // best effort
        }
        return null;
      }
    } catch {
      // Navigation in flight or probe raced a document swap — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const waited = Date.now() - start;
  if (last) {
    const parts = [`readyState=${last.readyState}`];
    if (!last.bodyVisible) parts.push('body hidden');
    parts.push(`${last.imgsPending}/${last.imgsViewport} viewport images pending`);
    return `[waited ${waited}ms — ${parts.join(', ')}]`;
  }
  return `[waited ${waited}ms — page readiness unknown]`;
}
