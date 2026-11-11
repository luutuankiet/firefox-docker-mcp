/**
 * extract_images: list the images on a page, then hand back the ones asked for
 * as image blocks.
 *
 * Read-only. Everything happens through BiDi against the named tab, so the
 * tab is never raised and nothing is written into the page: the person may be
 * using it.
 */

import { errorResponse } from '../utils/response-helpers.js';
import { isBiDiUnavailable, remoteValueToJs } from '../firefox/bidi-ops.js';
import { screenshotElementRef } from '../firefox/bidi-input.js';
import type { McpToolResponse } from '../types/common.js';

const LIST_CAP = 200;
const PICK_CAP = 10;
// The page's own work stops a little before the wire gives up, so whatever
// finished in time still comes back and the rest can be photographed instead.
const PAGE_DEADLINE_MS = 25_000;
const BIDI_TIMEOUT_MS = 30_000;

export const extractImagesTool = {
  name: 'extract_images',
  description:
    'List the images on a page (img, inline svg, canvas, CSS background), or return the ones picked by index as image blocks. Without pick: text list only. With pick: one text line per index, followed by a PNG/JPEG image or, if both the original and a rendered capture failed, an error line.',
  inputSchema: {
    type: 'object',
    properties: {
      pick: {
        type: 'array',
        items: { type: 'integer', minimum: 0 },
        maxItems: PICK_CAP,
        description: `Indexes from a previous list (at most ${PICK_CAP}). Omit to list.`,
      },
      selector: {
        type: 'string',
        description: 'Only look inside elements matching this CSS selector.',
      },
      minSize: {
        type: 'number',
        description: 'Skip images smaller than this in both CSS dimensions. Default 24.',
      },
      scale: {
        type: 'number',
        description: 'Rasterization scale for SVG. Default 2.',
      },
    },
  },
};

/**
 * Page-side enumeration, shared verbatim by list and pick so an index means the
 * same image in both - as long as the page has not changed in between.
 */
const ENUMERATE_SRC = String.raw`
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const enumerate = (selector, minSize) => {
    const out = [];
    const seen = new Set();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const firstUrl = (bg) => {
      const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(bg || '');
      return m ? m[2] : null;
    };
    const consider = (el) => {
      const tag = el.localName;
      let kind = null;
      let src = null;
      if (tag === 'img') {
        kind = 'img';
        src = el.currentSrc || el.src || '';
      } else if (tag === 'svg' && el.namespaceURI === SVG_NS) {
        kind = 'svg';
      } else if (tag === 'canvas') {
        kind = 'canvas';
      } else {
        let bg = null;
        try { bg = getComputedStyle(el).backgroundImage; } catch (e) { bg = null; }
        const u = bg && bg !== 'none' ? firstUrl(bg) : null;
        if (u) {
          kind = 'background';
          try { src = new URL(u, document.baseURI).href; } catch (e) { src = u; }
        }
      }
      if (!kind) return;
      const r = el.getBoundingClientRect();
      if (r.width < minSize && r.height < minSize) return;
      let vis = 'visible';
      const shown = typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
        : true;
      if (r.width === 0 || r.height === 0 || !shown) vis = 'hidden';
      else if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) vis = 'offscreen';
      let alt = '';
      if (tag === 'img') alt = el.getAttribute('alt') || '';
      if (!alt) alt = el.getAttribute('aria-label') || '';
      if (!alt && kind === 'svg') {
        const t = el.querySelector(':scope > title');
        alt = t ? t.textContent || '' : '';
      }
      out.push({
        kind,
        w: Math.round(r.width),
        h: Math.round(r.height),
        nw: tag === 'img' ? el.naturalWidth : 0,
        nh: tag === 'img' ? el.naturalHeight : 0,
        src,
        id: el.id || '',
        alt: alt.replace(/\s+/g, ' ').trim(),
        vis,
        el,
      });
    };
    const walk = (node) => {
      for (let el = node.firstElementChild; el; el = el.nextElementSibling) {
        if (seen.has(el)) continue;
        seen.add(el);
        const tag = el.localName;
        if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'template') continue;
        consider(el);
        // An inline svg is one picture; its shapes are not images of their own.
        if (tag === 'svg') continue;
        if (el.shadowRoot) walk(el.shadowRoot);
        walk(el);
      }
    };
    if (selector) {
      for (const root of document.querySelectorAll(selector)) {
        if (seen.has(root)) continue;
        seen.add(root);
        consider(root);
        if (root.localName !== 'svg') {
          if (root.shadowRoot) walk(root.shadowRoot);
          walk(root);
        }
      }
    } else if (document.documentElement) {
      const root = document.documentElement;
      seen.add(root);
      consider(root);
      walk(root);
    }
    return out;
  };
`;

const LIST_FN = `(selector, minSize, cap) => {
  ${ENUMERATE_SRC}
  const all = enumerate(selector, minSize);
  return {
    total: all.length,
    url: location.href,
    items: all.slice(0, cap).map(({ el, ...rest }) => rest),
  };
}`;

const PICK_FN = `async (selector, minSize, picks, scale, deadlineMs) => {
  ${ENUMERATE_SRC}
  const started = Date.now();
  const all = enumerate(selector, minSize);

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('could not read the bytes'));
    fr.readAsDataURL(blob);
  });

  // The header decides, not the declared type: servers mislabel images often.
  const sniff = async (blob) => {
    const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    return null;
  };

  const MAX_SIDE = 16384;
  const MAX_AREA = 16384 * 16384 / 4;
  const drawToPng = async (url, w, h, s, white) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    let cw = img.naturalWidth || w;
    let ch = img.naturalHeight || h;
    if (!cw || !ch) throw new Error('image has no size');
    let k = s;
    while ((cw * k > MAX_SIDE || ch * k > MAX_SIDE || cw * ch * k * k > MAX_AREA) && k > 0.05) k /= 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cw * k));
    c.height = Math.max(1, Math.round(ch * k));
    const ctx = c.getContext('2d');
    if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  };

  const fromUrl = async (url, w, h) => {
    if (!url) throw new Error('no src');
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const t = await sniff(blob);
    // GIFs are redrawn as PNG: the server can only downscale PNG and JPEG,
    // and an agent has no use for the animation.
    if (t && t !== 'image/gif') {
      return { mime: t, data: await blobToDataUrl(blob.type === t ? blob : new Blob([blob], { type: t })) };
    }
    const isSvg = !t && /svg/.test(blob.type);
    const u = URL.createObjectURL(blob);
    try {
      return { mime: 'image/png', data: await drawToPng(u, w, h, isSvg ? scale : 1, isSvg), from: blob.type || 'unknown type' };
    } finally {
      URL.revokeObjectURL(u);
    }
  };

  const fromSvg = async (el, w, h) => {
    const clone = el.cloneNode(true);
    if (w && h) { clone.setAttribute('width', String(w)); clone.setAttribute('height', String(h)); }
    let text = new XMLSerializer().serializeToString(clone);
    const open = (text.match(/^<svg[^>]*>/) || [''])[0];
    if (!/\\sxmlns=/.test(open)) text = text.replace(/^<svg/, '<svg xmlns="' + SVG_NS + '"');
    if (/xlink:/.test(text) && !/\\sxmlns:xlink=/.test(open)) {
      text = text.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    const u = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    try {
      return { mime: 'image/png', data: await drawToPng(u, w, h, scale, true) };
    } finally {
      URL.revokeObjectURL(u);
    }
  };

  const fetchOne = async (item) => {
    switch (item.kind) {
      case 'img':
      case 'background':
        return await fromUrl(item.src, item.w, item.h);
      case 'svg':
        return await fromSvg(item.el, item.w, item.h);
      case 'canvas': {
        const data = item.el.toDataURL('image/png');
        if (!data || data.length < 30) throw new Error('canvas is empty');
        return { mime: 'image/png', data };
      }
    }
    throw new Error('unknown kind');
  };

  const results = await Promise.all(picks.map(async (index) => {
    const item = all[index];
    if (!item) return { index, missing: true };
    const { el, ...meta } = item;
    const left = deadlineMs - (Date.now() - started);
    try {
      const got = await Promise.race([
        fetchOne(item),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), Math.max(0, left))),
      ]);
      return { index, ...meta, ok: true, mime: got.mime, data: got.data, from: got.from || '', el };
    } catch (e) {
      return { index, ...meta, ok: false, error: String((e && e.message) || e), el };
    }
  }));
  return { total: all.length, url: location.href, results };
}`;

interface ImageMeta {
  kind: string;
  w: number;
  h: number;
  nw: number;
  nh: number;
  src: string | null;
  id: string;
  alt: string;
  vis: string;
}

interface PickResult extends Partial<ImageMeta> {
  index: number;
  missing?: boolean;
  ok?: boolean;
  mime?: string;
  data?: string;
  from?: string;
  error?: string;
  el?: { sharedId: string } | null;
}

/**
 * Like remoteValueToJs, but keeps a DOM node as the reference the browser can
 * act on. That reference is the only way back to the element for the rendered
 * fallback without leaving a mark in the page.
 */
function remoteToPlain(value: any): unknown {
  if (!value || typeof value !== 'object') return value ?? null;
  switch (value.type) {
    case 'node':
      return typeof value.sharedId === 'string' ? { sharedId: value.sharedId } : null;
    case 'array':
      return Array.isArray(value.value) ? value.value.map(remoteToPlain) : [];
    case 'object': {
      if (!Array.isArray(value.value)) return {};
      const out: Record<string, unknown> = {};
      for (const entry of value.value) {
        if (!Array.isArray(entry)) continue;
        const [k, v] = entry;
        out[typeof k === 'string' ? k : String(remoteValueToJs(k))] = remoteToPlain(v);
      }
      return out;
    }
    default:
      return remoteValueToJs(value);
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A src for a text line. An inline data: URL is described, never copied. */
function describeSrc(src: string): string {
  const data = /^data:([^;,]*)/i.exec(src);
  if (data) {
    return `data:${data[1] || 'unknown'} (${(src.length / 1024).toFixed(1)} KB inline)`;
  }
  return clip(src, 200);
}

function formatLine(index: number, m: Partial<ImageMeta>): string {
  const parts = [`[${index}]`, String(m.kind), `${m.w}x${m.h}`, String(m.vis)];
  if (m.kind === 'img' && m.nw && m.nh && (m.nw !== m.w || m.nh !== m.h)) {
    parts.push(`natural ${m.nw}x${m.nh}`);
  }
  if (m.src) parts.push(`src=${describeSrc(m.src)}`);
  if (m.id) parts.push(`id=${clip(m.id, 80)}`);
  if (m.alt) parts.push(`alt="${clip(m.alt, 120)}"`);
  return parts.join(' ');
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+)((?:;[^;,]*)*),/i.exec(dataUrl);
  if (!m) return null;
  const mime = m[1]!.toLowerCase();
  const body = dataUrl.slice(m[0].length);
  if (!body) return null;
  const base64 = /;base64/i.test(m[2] ?? '')
    ? body
    : Buffer.from(decodeURIComponent(body), 'utf8').toString('base64');
  return { mime, base64 };
}

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif']);

async function callInTab(
  firefox: { sendBiDiCommand: (m: string, p?: Record<string, any>, t?: number) => Promise<any> },
  tabId: string,
  fn: string,
  args: unknown[],
  timeoutMs?: number
): Promise<unknown> {
  const toRemote = (v: unknown): Record<string, unknown> => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'string') return { type: 'string', value: v };
    if (typeof v === 'number') return { type: 'number', value: v };
    if (Array.isArray(v)) return { type: 'array', value: v.map(toRemote) };
    throw new Error(`unsupported argument ${typeof v}`);
  };
  const res = await firefox.sendBiDiCommand(
    'script.callFunction',
    {
      functionDeclaration: fn,
      target: { context: tabId },
      awaitPromise: true,
      arguments: args.map(toRemote),
      // Deep enough for result -> list -> item -> element; the element itself
      // comes back as a bare reference, never a serialized subtree.
      serializationOptions: { maxObjectDepth: 6, maxDomDepth: 0 },
    },
    timeoutMs
  );
  if (res?.type === 'exception') {
    const detail = res.exceptionDetails ?? {};
    const text =
      detail.text ??
      (detail.exception ? String(remoteValueToJs(detail.exception)) : 'script threw');
    throw new Error(`Script threw in page: ${text}`);
  }
  return remoteToPlain(res?.result);
}

export async function handleExtractImages(args: unknown): Promise<McpToolResponse> {
  try {
    const {
      pick,
      selector,
      minSize: rawMin,
      scale: rawScale,
      tab,
    } = (args ?? {}) as {
      pick?: unknown;
      selector?: string;
      minSize?: number;
      scale?: number;
      tab?: string;
    };

    const minSize = typeof rawMin === 'number' && rawMin >= 0 ? rawMin : 24;
    const scale = typeof rawScale === 'number' && rawScale > 0 ? Math.min(rawScale, 8) : 2;
    const sel = typeof selector === 'string' && selector.trim() ? selector : null;

    let picks: number[] | null = null;
    if (pick !== undefined && pick !== null) {
      if (
        !Array.isArray(pick) ||
        pick.length === 0 ||
        !pick.every((n) => Number.isInteger(n) && (n as number) >= 0)
      ) {
        throw new Error('pick must be a list of image indexes from a previous list, e.g. [0, 3]');
      }
      picks = [...new Set(pick as number[])];
      if (picks.length > PICK_CAP) {
        throw new Error(`pick takes at most ${PICK_CAP} indexes per call; got ${picks.length}`);
      }
    }

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    // The tab the dispatcher resolved, read by its BiDi context so it is never
    // raised. Without one, the tab already in front is read in place.
    const tabId = tab || firefox.getCurrentContextId();
    if (!tabId) {
      throw new Error('No tab to read. Pass tab, or open one with new_page.');
    }

    const scope = `minSize ${minSize}${sel ? `, inside "${sel}"` : ''}`;

    try {
      if (!picks) {
        const listed = (await callInTab(firefox, tabId, LIST_FN, [sel, minSize, LIST_CAP], BIDI_TIMEOUT_MS)) as {
          total: number;
          url: string;
          items: ImageMeta[];
        };
        const lines = [
          `${listed.total} image${listed.total === 1 ? '' : 's'} on ${describeSrc(listed.url)} (${scope}).`,
        ];
        if (listed.total > 0) {
          lines.push(`Get them with extract_images pick:[index, ...], at most ${PICK_CAP} per call.`);
        }
        listed.items.forEach((item, i) => lines.push(formatLine(i, item)));
        const omitted = listed.total - listed.items.length;
        if (omitted > 0) {
          lines.push(`(${omitted} more not listed; narrow with selector or minSize)`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      const picked = (await callInTab(
        firefox,
        tabId,
        PICK_FN,
        [sel, minSize, picks, scale, PAGE_DEADLINE_MS],
        BIDI_TIMEOUT_MS
      )) as { total: number; url: string; results: PickResult[] };

      const sendBiDi = (method: string, params?: Record<string, any>) =>
        firefox.sendBiDiCommand(method, params ?? {});

      // Rendered fallbacks run one after another, each with its own settle and
      // capture; one shared budget keeps ten of them from running for minutes.
      const fallbackDeadline = Date.now() + BIDI_TIMEOUT_MS;
      const content: McpToolResponse['content'] = [];
      for (const r of picked.results) {
        if (r.missing) {
          content.push({
            type: 'text',
            text: `[${r.index}] not found: the page now has ${picked.total} image${picked.total === 1 ? '' : 's'} (${scope}). List again.`,
          });
          continue;
        }
        const line = formatLine(r.index, r);

        let failure = r.error ?? '';
        if (r.ok && r.data) {
          const parsed = parseDataUrl(r.data);
          if (parsed && ALLOWED_MIME.has(parsed.mime)) {
            const note = r.from ? ` (converted from ${r.from})` : '';
            content.push({ type: 'text', text: `${line} source: original${note}` });
            content.push({ type: 'image', data: parsed.base64, mimeType: parsed.mime });
            continue;
          }
          failure = parsed ? `came back as ${parsed.mime}` : 'came back unreadable';
        }

        // Cross-origin without CORS, a tainted canvas, a decode error: what the
        // person sees is still on screen, so photograph the element instead.
        if (r.el?.sharedId && Date.now() >= fallbackDeadline) {
          failure = `${failure}; out of time for a rendered capture, pick it again on its own`;
        } else if (r.el?.sharedId) {
          try {
            const png = await screenshotElementRef(sendBiDi, tabId, r.el.sharedId);
            content.push({
              type: 'text',
              text: `${line} source: rendered (original failed: ${clip(failure, 160)})`,
            });
            content.push({ type: 'image', data: png, mimeType: 'image/png' });
            continue;
          } catch (shotError) {
            failure = `${failure}; rendered capture failed: ${(shotError as Error).message}`;
          }
        }
        content.push({ type: 'text', text: `${line} error: ${clip(failure, 300)}` });
      }
      return { content };
    } catch (error) {
      if (isBiDiUnavailable(error) && !/BiDi command timeout/.test(String(error))) {
        throw new Error(
          `extract_images needs WebDriver BiDi, which this connection does not offer: ${(error as Error).message}`
        );
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error as Error);
  }
}
