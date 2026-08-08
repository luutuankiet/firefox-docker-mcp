/**
 * Tab-targeted browser operations.
 *
 * The classic WebDriver API acts on whichever tab is focused, so every call has
 * to raise its tab first - which drags the view of anyone watching over VNC and
 * makes concurrent agents fight over focus. BiDi commands name their tab in the
 * request instead, so the same work happens wherever the tab already is.
 *
 * Each function throws when the command is unavailable or fails; callers are
 * expected to fall back to the classic path rather than surface the error, so a
 * browser without the Remote Agent keeps working exactly as before.
 */

export type SendBiDi = (method: string, params?: Record<string, any>) => Promise<any>;

/**
 * Whether a failure means "this browser cannot do it that way" rather than
 * "the operation failed".
 *
 * The distinction decides whether falling back to the classic path is honest.
 * A page that threw, or a URL that would not load, fails the same way on both
 * paths, and retrying it only doubles the wait before the same error surfaces.
 */
export function isBiDiUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /bidi|websocket|unavailable|not connected|unknown command|no such command|unsupported|timed out waiting for bidi/i.test(
    message
  );
}

/**
 * Turn a BiDi RemoteValue back into an ordinary JavaScript value.
 *
 * Values cross the wire tagged by type, with objects and arrays carrying their
 * members as nested RemoteValues. Anything with no plain representation - a DOM
 * node, a function, a live handle - collapses to a short descriptor, because the
 * alternative is either a serialization error or a wall of internal ids.
 */
export function remoteValueToJs(value: any): unknown {
  if (!value || typeof value !== 'object') {
    return value ?? null;
  }

  switch (value.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
    case 'boolean':
      return value.value;
    case 'number':
      // Infinity and NaN have no JSON form, so BiDi sends them as strings.
      if (typeof value.value === 'string') {
        return value.value === 'NaN' ? NaN : Number(value.value);
      }
      return value.value;
    case 'bigint':
      return String(value.value);
    case 'date':
      return value.value;
    case 'array':
    case 'set':
      return Array.isArray(value.value) ? value.value.map(remoteValueToJs) : [];
    case 'object':
    case 'map': {
      if (!Array.isArray(value.value)) {
        // Depth limit reached: the object exists but its members were not sent.
        return {};
      }
      const out: Record<string, unknown> = {};
      for (const entry of value.value) {
        if (!Array.isArray(entry)) continue;
        const [rawKey, rawVal] = entry;
        const key = typeof rawKey === 'string' ? rawKey : String(remoteValueToJs(rawKey));
        out[key] = remoteValueToJs(rawVal);
      }
      return out;
    }
    case 'node':
      return `[node ${value.value?.localName ?? 'element'}]`;
    case 'function':
      return '[function]';
    case 'error':
      return `[error ${value.value ?? ''}]`.trim();
    default:
      return value.value ?? `[${value.type}]`;
  }
}

/**
 * Navigate a tab without focusing it.
 *
 * Waits for the load to complete so the caller sees a settled page, matching
 * what the classic driver.get did.
 */
export async function navigateInContext(
  sendBiDi: SendBiDi,
  context: string,
  url: string
): Promise<{ url: string }> {
  const res = await sendBiDi('browsingContext.navigate', {
    context,
    url,
    wait: 'complete',
  });
  return { url: typeof res?.url === 'string' ? res.url : url };
}

/**
 * Run a function in a tab without focusing it.
 *
 * The tool's contract is a function string rather than an expression, which maps
 * onto callFunction directly. Promises are awaited server-side so an async
 * function returns its resolved value rather than a pending handle.
 */
export async function callFunctionInContext(
  sendBiDi: SendBiDi,
  context: string,
  functionDeclaration: string
): Promise<unknown> {
  const res = await sendBiDi('script.callFunction', {
    functionDeclaration,
    target: { context },
    awaitPromise: true,
    arguments: [],
    // Without an explicit depth, objects arrive as empty shells. DOM nodes stay
    // at depth zero because a serialized subtree is never what a caller wanted.
    serializationOptions: { maxObjectDepth: 10, maxDomDepth: 0 },
  });

  if (res?.type === 'exception') {
    const detail = res.exceptionDetails ?? {};
    const text =
      detail.text ??
      (detail.exception ? String(remoteValueToJs(detail.exception)) : 'script threw');
    throw new Error(`Script threw in page: ${text}`);
  }

  return remoteValueToJs(res?.result);
}

/**
 * Capture a tab without focusing it.
 *
 * Firefox throttles rendering in tabs that are not on screen, so a background
 * capture can come back blank or stale. Callers should treat a failure here as a
 * reason to fall back rather than as a hard error.
 */
/**
 * Let the window catch up with a tab that has just come to the front.
 *
 * A capture reads the surface the window last composited, which is not the same
 * thing as the page being ready: a tab raised a moment ago already has a loaded,
 * painted document while the window is still showing the tab before it, and the
 * picture comes back of the wrong page entirely.
 *
 * Two frames are enough - the first is the one being composited now, the second
 * is the one holding this tab. A tab that is not on screen composites on its own
 * and has nothing to wait for. The race covers a visible tab whose frames are
 * throttled regardless (occluded, or another window on top), where the callback
 * may never run at all.
 */
export async function settleCompositor(sendBiDi: SendBiDi, context: string): Promise<void> {
  const fn = `() => new Promise((resolve) => {
    if (document.hidden) { resolve(true); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  })`;

  try {
    await Promise.race([
      sendBiDi('script.callFunction', {
        functionDeclaration: fn,
        target: { context },
        awaitPromise: true,
        serializationOptions: { maxDomDepth: 0 },
      }),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  } catch {
    // Waiting improves the picture; it is never a reason to fail to take one.
  }
}

/**
 * Resize one tab's content viewport, leaving the window - and therefore every
 * other tab, and the view of anyone watching over VNC - alone.
 *
 * The classic WebDriver equivalent resizes the OS window, which is a fleet-wide
 * change dressed up as a per-call one: an agent laying out a phone screen would
 * reshape every other agent's page at the same time. This names its tab.
 *
 * A null viewport hands the tab back to whatever the window says.
 */
export async function setViewportInContext(
  sendBiDi: SendBiDi,
  context: string,
  viewport: { width: number; height: number } | null,
  devicePixelRatio?: number | null
): Promise<void> {
  const params: Record<string, unknown> = { context, viewport };
  if (devicePixelRatio !== undefined) {
    params.devicePixelRatio = devicePixelRatio;
  }
  await sendBiDi('browsingContext.setViewport', params);
}

export async function screenshotContext(sendBiDi: SendBiDi, context: string): Promise<string> {
  await settleCompositor(sendBiDi, context);
  const res = await sendBiDi('browsingContext.captureScreenshot', {
    context,
    origin: 'viewport',
  });
  const data = res?.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('captureScreenshot returned no data');
  }
  return data;
}

/**
 * Wait until a tab has something worth photographing.
 *
 * Mirrors the readiness probe used for the focused tab - document loaded, body
 * laid out, viewport images decoded - but asks the tab directly so no switch is
 * needed. Returns a note describing what was still pending on timeout, or null
 * when the page settled.
 */
export async function waitForContextReady(
  sendBiDi: SendBiDi,
  context: string,
  timeoutMs: number
): Promise<string | null> {
  if (timeoutMs <= 0) {
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  const probe = `() => {
    const pending = [];
    if (document.readyState !== 'complete') pending.push('document ' + document.readyState);
    // A loaded document is not a drawn one. A tab that has never painted still
    // hands back the last frame the window composited - which is whatever tab
    // was there before, photographed and reported as this one.
    if (!document.hidden && performance.getEntriesByType('paint').length === 0) {
      pending.push('first paint');
    }
    const body = document.body;
    if (!body) {
      pending.push('no body');
    } else {
      const style = getComputedStyle(body);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        pending.push('body hidden');
      }
    }
    const h = window.innerHeight, w = window.innerWidth;
    let images = 0;
    for (const img of document.images) {
      if (img.complete) continue;
      const r = img.getBoundingClientRect();
      if (r.bottom > 0 && r.top < h && r.right > 0 && r.left < w) images++;
    }
    if (images) pending.push(images + ' viewport images loading');
    return pending;
  }`;

  let pending: unknown = [];
  while (Date.now() < deadline) {
    try {
      pending = await callFunctionInContext(sendBiDi, context, probe);
    } catch {
      // A tab mid-navigation has no realm to evaluate in yet; try again.
      pending = ['page not ready'];
    }
    if (Array.isArray(pending) && pending.length === 0) {
      return null;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const items = Array.isArray(pending) ? pending.join(', ') : String(pending);
  return items ? `⏳ captured before the page settled: ${items}` : null;
}
