/**
 * Text boxes for screenshots: the visible text of the captured region, read
 * from the DOM, in the pixel coordinates of the image the caller receives.
 *
 * The page does the measuring (one BiDi call): it walks text nodes, measures
 * each word with a Range, drops hidden, clipped and covered words, and merges
 * words into lines. The server converts CSS px to image px with the page's
 * devicePixelRatio and clamps to the image size read from its header.
 *
 * Not covered: form field values, ::before/::after content, iframes.
 */

type Firefox = Awaited<ReturnType<typeof import('../index.js').getFirefox>>;

export interface TextBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextBoxesPayload {
  width: number;
  height: number;
  boxes: TextBox[];
}

export type TextBoxRegion =
  | { mode: 'viewport' }
  | { mode: 'document'; x: number; y: number; width: number; height: number }
  | { mode: 'element'; sharedId: string };

/** Words scanned in the page before giving up. */
const MAX_WORDS = 30000;
/** Boxes returned inline, and in a sidecar file. */
export const MAX_INLINE_BOXES = 1000;
export const MAX_SIDECAR_BOXES = 10000;

/**
 * Runs in the page. Arguments: a JSON spec string, then the element (or null).
 * Returns a JSON string so BiDi's depth and size limits never apply.
 */
const MEASURE_FN = `function (specJson, el) {
  const spec = JSON.parse(specJson);
  const vv = window.visualViewport;
  const vw = vv ? vv.width : window.innerWidth;
  const vh = vv ? vv.height : window.innerHeight;
  let region;
  if (spec.mode === 'element') {
    if (!el) { return JSON.stringify({ error: 'element not found' }); }
    const r = el.getBoundingClientRect();
    region = { x: r.left, y: r.top, w: r.width, h: r.height };
  } else if (spec.mode === 'document') {
    region = { x: spec.x - window.scrollX, y: spec.y - window.scrollY, w: spec.width, h: spec.height };
  } else {
    region = { x: 0, y: 0, w: vw, h: vh };
  }
  const clipCache = new Map();
  const clipOf = (node) => {
    if (!node || node.nodeType !== 1 || node === document.documentElement || node === document.body) {
      return null;
    }
    if (clipCache.has(node)) { return clipCache.get(node); }
    const cs = getComputedStyle(node);
    let parentClip;
    if (cs.position === 'fixed') {
      parentClip = null;
    } else {
      let p = node.parentNode;
      if (p && p.nodeType === 11) { p = p.host; }
      parentClip = clipOf(p);
    }
    let clip = parentClip;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = node.getBoundingClientRect();
      const own = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      clip = clip
        ? { l: Math.max(clip.l, own.l), t: Math.max(clip.t, own.t), r: Math.min(clip.r, own.r), b: Math.min(clip.b, own.b) }
        : own;
    }
    clipCache.set(node, clip);
    return clip;
  };
  const blockOf = (node) => {
    let n = node;
    while (n && n.nodeType === 1) {
      const d = getComputedStyle(n).display;
      if (!d.startsWith('inline') && d !== 'contents') { return n; }
      let p = n.parentNode;
      if (p && p.nodeType === 11) { p = p.host; }
      n = p;
    }
    return n;
  };
  const visCache = new Map();
  const visible = (p) => {
    if (visCache.has(p)) { return visCache.get(p); }
    let ok = true;
    if (typeof p.checkVisibility === 'function') {
      ok = p.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
    }
    visCache.set(p, ok);
    return ok;
  };
  const words = [];
  let scanned = 0;
  let truncated = false;
  const range = document.createRange();
  const walkRoot = (root) => {
    const shadows = [];
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === 3) { return NodeFilter.FILTER_ACCEPT; }
        const tag = n.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') { return NodeFilter.FILTER_REJECT; }
        if (n.shadowRoot) { shadows.push(n.shadowRoot); }
        return NodeFilter.FILTER_SKIP;
      },
    });
    let node = tw.nextNode();
    while (node) {
      if (scanned >= ${MAX_WORDS}) { truncated = true; return; }
      const parent = node.parentElement;
      const text = node.data;
      if (parent && text && /\\S/.test(text) && visible(parent)) {
        const pe = getComputedStyle(parent).pointerEvents;
        const re = /\\S+/g;
        let m;
        while ((m = re.exec(text))) {
          scanned++;
          if (scanned > ${MAX_WORDS}) { truncated = true; break; }
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const rects = range.getClientRects();
          for (const r of rects) {
            if (r.width <= 0 || r.height <= 0) { continue; }
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if (cx < region.x || cy < region.y || cx > region.x + region.w || cy > region.y + region.h) { continue; }
            const clip = clipOf(parent);
            if (clip && (cx < clip.l || cx > clip.r || cy < clip.t || cy > clip.b)) { continue; }
            if (pe !== 'none' && cx >= 0 && cy >= 0 && cx < vw && cy < vh) {
              const rootNode = parent.getRootNode();
              const hit = (rootNode && rootNode.elementFromPoint ? rootNode : document).elementFromPoint(cx, cy);
              if (hit && hit !== parent && !hit.contains(parent) && !parent.contains(hit)) { continue; }
            }
            words.push({ t: m[0], l: r.left, tp: r.top, r: r.right, b: r.bottom, blk: blockOf(parent) });
            break;
          }
        }
      }
      node = tw.nextNode();
    }
    for (const sr of shadows) { walkRoot(sr); }
  };
  walkRoot(document.body || document.documentElement);
  const lines = [];
  let cur = null;
  for (const w of words) {
    if (cur) {
      const h = Math.min(cur.b - cur.tp, w.b - w.tp);
      const overlap = Math.min(cur.b, w.b) - Math.max(cur.tp, w.tp);
      const gap = w.l - cur.r;
      if (cur.blk === w.blk && overlap >= h / 2 && gap <= 0.8 * h && gap >= -0.5 * h) {
        cur.t += (gap > 0.15 * h ? ' ' : '') + w.t;
        cur.l = Math.min(cur.l, w.l); cur.tp = Math.min(cur.tp, w.tp);
        cur.r = Math.max(cur.r, w.r); cur.b = Math.max(cur.b, w.b);
        continue;
      }
      lines.push(cur);
    }
    cur = { t: w.t, l: w.l, tp: w.tp, r: w.r, b: w.b, blk: w.blk };
  }
  if (cur) { lines.push(cur); }
  return JSON.stringify({
    dpr: window.devicePixelRatio || 1,
    ox: region.x, oy: region.y,
    truncated,
    lines: lines.map((l) => [l.t, l.l, l.tp, l.r, l.b]),
  });
}`;

/** Pixel size of a base64 PNG or JPEG, read from its header. */
export function imageDimensions(base64: string, mimeType: string): { width: number; height: number } | null {
  try {
    const bytes = Buffer.from(base64.slice(0, mimeType === 'image/png' ? 64 : base64.length), 'base64');
    if (mimeType === 'image/png') {
      if (bytes.length < 24) {
        return null;
      }
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Measure the text boxes of a region, in image px. Returns the payload and
 * whether the page stopped scanning early.
 */
export async function measureTextBoxes(
  firefox: Firefox,
  tab: string,
  region: TextBoxRegion,
  image: { base64: string; mimeType: string }
): Promise<{ payload: TextBoxesPayload; truncated: boolean }> {
  const dims = imageDimensions(image.base64, image.mimeType);
  if (!dims) {
    throw new Error('could not read the image size');
  }
  const spec = region.mode === 'element' ? { mode: 'element' } : region;
  const elArg = region.mode === 'element' ? { sharedId: region.sharedId } : { type: 'null' };
  const raw = await firefox.evaluateInTab(tab, MEASURE_FN, [
    { type: 'string', value: JSON.stringify(spec) },
    elArg,
  ]);
  if (typeof raw !== 'string') {
    throw new Error('the page returned no measurements');
  }
  const res = JSON.parse(raw) as {
    error?: string;
    dpr: number;
    ox: number;
    oy: number;
    truncated: boolean;
    lines: [string, number, number, number, number][];
  };
  if (res.error) {
    throw new Error(res.error);
  }
  const dpr = res.dpr > 0 ? res.dpr : 1;
  const boxes: TextBox[] = [];
  for (const [text, l, t, r, b] of res.lines) {
    const x0 = Math.max(0, Math.min(dims.width, (l - res.ox) * dpr));
    const y0 = Math.max(0, Math.min(dims.height, (t - res.oy) * dpr));
    const x1 = Math.max(0, Math.min(dims.width, (r - res.ox) * dpr));
    const y1 = Math.max(0, Math.min(dims.height, (b - res.oy) * dpr));
    const x = Math.round(x0);
    const y = Math.round(y0);
    const w = Math.round(x1) - x;
    const h = Math.round(y1) - y;
    if (w <= 0 || h <= 0) {
      continue;
    }
    boxes.push({ text, x, y, w, h });
  }
  return { payload: { width: dims.width, height: dims.height, boxes }, truncated: res.truncated };
}

/** `{"width":W,"height":H,"boxes":[` then one box per line, then `]}`. */
export function formatTextBoxes(payload: TextBoxesPayload): string {
  const head = `{"width":${payload.width},"height":${payload.height},"boxes":[`;
  if (payload.boxes.length === 0) {
    return `${head}]}`;
  }
  return `${head}\n${payload.boxes.map((b) => JSON.stringify(b)).join(',\n')}\n]}`;
}

/** True when a text block is a text-boxes payload produced by formatTextBoxes. */
export function isTextBoxesText(text: unknown): text is string {
  return typeof text === 'string' && text.startsWith('{"width":') && text.includes('"boxes":[');
}

/** Rescale a payload to a new image size (used after an inline image is shrunk). */
export function rescaleTextBoxes(payload: TextBoxesPayload, width: number, height: number): TextBoxesPayload {
  const sx = width / payload.width;
  const sy = height / payload.height;
  const boxes: TextBox[] = [];
  for (const b of payload.boxes) {
    const x = Math.round(b.x * sx);
    const y = Math.round(b.y * sy);
    const w = Math.max(1, Math.min(width - x, Math.round((b.x + b.w) * sx) - x));
    const h = Math.max(1, Math.min(height - y, Math.round((b.y + b.h) * sy) - y));
    boxes.push({ text: b.text, x, y, w, h });
  }
  return { width, height, boxes };
}
