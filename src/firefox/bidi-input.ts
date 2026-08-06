/**
 * Tab-targeted input.
 *
 * The classic driver's input goes wherever the browser is looking, because the
 * commands describe a mouse and a keyboard rather than a tab. BiDi's input
 * commands name their tab, so a click can land on a page that is not on screen
 * and the person watching over VNC keeps whatever they had in front of them.
 *
 * Elements are addressed by a reference the browser hands back, not by a driver
 * handle, so nothing here needs the tab to be current at any point.
 *
 * Every function throws when the browser cannot work this way; callers fall
 * back to the classic path, which raises the tab and does the same work.
 */

import { settleCompositor } from './bidi-ops.js';
import type { SendBiDi } from './bidi-ops.js';

// Input sources persist across calls within a tab, so the ids are stable.
const MOUSE = 'mcp-mouse';
const KEYBOARD = 'mcp-keys';

// WebDriver spells non-printing keys as private-use codepoints.
const KEY_CONTROL = '';
const KEY_DELETE = '';

/**
 * Find an element in a tab and hand back the browser's reference to it.
 *
 * The uid layer already knows the selector, so this never needs a snapshot of
 * its own. Scrolling happens here because input against an off-screen element
 * is refused - the pointer needs somewhere real to aim.
 *
 * A missing element throws rather than reporting a fallback-worthy failure: it
 * would be missing on the classic path too, and retrying only delays the same
 * answer.
 */
export async function findElementRef(
  sendBiDi: SendBiDi,
  context: string,
  css: string,
  xpath?: string
): Promise<string> {
  const fn = `(css, xpath) => {
    let el = null;
    try { el = document.querySelector(css); } catch (e) { el = null; }
    if (!el && xpath) {
      try {
        el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      } catch (e) { el = null; }
    }
    if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
    return el;
  }`;

  const res = await sendBiDi('script.callFunction', {
    functionDeclaration: fn,
    target: { context },
    awaitPromise: false,
    arguments: [
      { type: 'string', value: css },
      xpath ? { type: 'string', value: xpath } : { type: 'null' },
    ],
    // The reference is the whole point; a serialized subtree is never wanted.
    serializationOptions: { maxDomDepth: 0 },
  });

  if (res?.type === 'exception') {
    throw new Error(`Could not look for the element: ${res.exceptionDetails?.text ?? 'unknown'}`);
  }

  const sharedId = res?.result?.sharedId;
  if (typeof sharedId !== 'string' || sharedId.length === 0) {
    throw new Error(
      `Element is no longer on the page (${css}). It may have changed - take a fresh snapshot.`
    );
  }
  return sharedId;
}

/**
 * Run an input sequence, then let go of whatever it was holding.
 *
 * A button or modifier left down outlives the call and would corrupt every
 * later action in that tab - including a person's own clicks.
 */
async function performActions(
  sendBiDi: SendBiDi,
  context: string,
  actions: unknown[]
): Promise<void> {
  try {
    await sendBiDi('input.performActions', { context, actions });
  } finally {
    try {
      await sendBiDi('input.releaseActions', { context });
    } catch {
      // Nothing was held, or the tab is gone; either way there is nothing to undo.
    }
  }
}

function pointerAt(sharedId: string, actions: unknown[]) {
  return {
    type: 'pointer',
    id: MOUSE,
    parameters: { pointerType: 'mouse' },
    actions: [
      // Aiming at the element rather than at coordinates keeps the click correct
      // when the page reflows between locating and pressing.
      { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId } } },
      ...actions,
    ],
  };
}

/** Click an element in a tab, without bringing that tab to the front. */
export async function clickElementRef(
  sendBiDi: SendBiDi,
  context: string,
  sharedId: string,
  dblClick = false
): Promise<void> {
  const press = [
    { type: 'pointerDown', button: 0 },
    { type: 'pointerUp', button: 0 },
  ];
  await performActions(sendBiDi, context, [
    pointerAt(sharedId, dblClick ? [...press, { type: 'pause', duration: 20 }, ...press] : press),
  ]);
}

/**
 * Move the pointer onto an element.
 *
 * A real pointer move is what makes :hover and mouseenter fire; dispatching the
 * events by hand would leave the page's own styling untouched.
 */
export async function hoverElementRef(
  sendBiDi: SendBiDi,
  context: string,
  sharedId: string
): Promise<void> {
  await performActions(sendBiDi, context, [pointerAt(sharedId, [])]);
}

/**
 * Replace the contents of a text field by typing into it.
 *
 * Clicking first is what gives the field focus - keyboard input goes to whatever
 * the page considers focused, not to an element named in the request. Typing
 * character by character produces the same key and input events a person would,
 * which is what pages built on those events are waiting for.
 */
export async function fillElementRef(
  sendBiDi: SendBiDi,
  context: string,
  sharedId: string,
  value: string
): Promise<void> {
  await clickElementRef(sendBiDi, context, sharedId);

  const keys: unknown[] = [
    { type: 'keyDown', value: KEY_CONTROL },
    { type: 'keyDown', value: 'a' },
    { type: 'keyUp', value: 'a' },
    { type: 'keyUp', value: KEY_CONTROL },
    { type: 'keyDown', value: KEY_DELETE },
    { type: 'keyUp', value: KEY_DELETE },
  ];

  // Split by codepoint: a key value has to be a single character, and a naive
  // index walk would tear emoji in half.
  for (const ch of Array.from(value)) {
    keys.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
  }

  await performActions(sendBiDi, context, [{ type: 'key', id: KEYBOARD, actions: keys }]);
}

/**
 * Drag one element onto another using HTML5 drag events.
 *
 * Kept as page-level events rather than a pointer sequence because that is what
 * the classic path did and what the drag libraries in the wild actually listen
 * for - a real pointer drag moves the mouse but never fires a drop.
 */
export async function dragElementRefs(
  sendBiDi: SendBiDi,
  context: string,
  fromSharedId: string,
  toSharedId: string
): Promise<void> {
  const fn = `(srcEl, tgtEl) => {
    if (!srcEl || !tgtEl) throw new Error('drag: element not found');
    function dispatch(type, target, dt) {
      return target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    var dt = typeof DataTransfer !== 'undefined' ? new DataTransfer() : undefined;
    dispatch('dragstart', srcEl, dt);
    dispatch('dragenter', tgtEl, dt);
    dispatch('dragover', tgtEl, dt);
    dispatch('drop', tgtEl, dt);
    dispatch('dragend', srcEl, dt);
    return true;
  }`;

  const res = await sendBiDi('script.callFunction', {
    functionDeclaration: fn,
    target: { context },
    awaitPromise: false,
    arguments: [{ sharedId: fromSharedId }, { sharedId: toSharedId }],
    serializationOptions: { maxDomDepth: 0 },
  });

  if (res?.type === 'exception') {
    throw new Error(`Drag failed in page: ${res.exceptionDetails?.text ?? 'unknown'}`);
  }
}

/**
 * Make a file input reachable and confirm it is one.
 *
 * Sites routinely hide the real input behind a styled button, and a hidden
 * element cannot receive a file. Checking the tag here turns a confusing
 * downstream failure into a plain answer.
 */
export async function prepareFileInputRef(
  sendBiDi: SendBiDi,
  context: string,
  sharedId: string
): Promise<void> {
  const fn = `(element) => {
    if (!element) throw new Error('upload: element not found');
    if (element.tagName !== 'INPUT' || element.type !== 'file')
      throw new Error('upload: element must be <input type=file>');
    var style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      var s = element.style;
      s.display = 'block'; s.visibility = 'visible'; s.opacity = '1';
      s.position = 'fixed'; s.left = '0px'; s.top = '0px';
      s.zIndex = '2147483647';
    }
    return true;
  }`;

  const res = await sendBiDi('script.callFunction', {
    functionDeclaration: fn,
    target: { context },
    awaitPromise: false,
    arguments: [{ sharedId }],
    serializationOptions: { maxDomDepth: 0 },
  });

  if (res?.type === 'exception') {
    throw new Error(res.exceptionDetails?.text ?? 'upload: element is not usable');
  }
}

/**
 * Hand a file to a file input.
 *
 * The path is read by the browser, so it has to exist inside the container
 * rather than on the machine calling the tool.
 */
export async function setFilesOnElementRef(
  sendBiDi: SendBiDi,
  context: string,
  sharedId: string,
  filePath: string
): Promise<void> {
  await sendBiDi('input.setFiles', {
    context,
    element: { sharedId },
    files: [filePath],
  });
}

/** Photograph a single element, without bringing its tab to the front. */
export async function screenshotElementRef(
  sendBiDi: SendBiDi,
  context: string,
  sharedId: string
): Promise<string> {
  await settleCompositor(sendBiDi, context);
  const res = await sendBiDi('browsingContext.captureScreenshot', {
    context,
    origin: 'document',
    clip: { type: 'element', element: { sharedId } },
  });
  const data = res?.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('captureScreenshot returned no data');
  }
  return data;
}

/**
 * Give the page a moment to react to what just happened.
 *
 * The wait is counted here rather than in the page because Firefox throttles
 * timers and frame callbacks in tabs that are not on screen - the very tabs
 * this module exists to act on. An in-page wait would stall for a second or
 * never resolve at all.
 */
export async function settleAfterAction(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
