/**
 * query_dom — token-efficient DOM query/aggregate via an injected browser script.
 * The browser IS the DOM engine (no cheerio dependency). Mirrors fs-mcp `hq` UX:
 * orient with mode=outline (no selector), then drill with a selector + a mode.
 * mode:outer on '.mermaid-block svg' returns raw SVG markup take_snapshot collapses.
 */

import {
  successResponse,
  errorResponse,
  truncateText,
  TOKEN_LIMITS,
} from '../utils/response-helpers.js';
import type { McpToolResponse } from '../types/common.js';

export const queryDomTool = {
  name: 'query_dom',
  description:
    'Query/aggregate the live page DOM token-efficiently. modes: outline (structure map, default when no selector), text, html, outer, attr, styles, table, count, json. Orient with outline then drill via a selector. outer on ".mermaid-block svg" returns the raw SVG markup that take_snapshot collapses into prose. Output is compact JSON; use omitAttrs to drop noisy attributes (e.g. class, style).',
  inputSchema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector. Omit for an outline of document.body.',
      },
      mode: {
        type: 'string',
        enum: ['outline', 'text', 'html', 'outer', 'attr', 'styles', 'table', 'count', 'json'],
        description: 'Extraction mode. Default: outline when no selector, else text.',
      },
      attr: {
        type: 'string',
        description: 'For mode=attr: attribute name, "*" for all, or a comma-separated list.',
      },
      omitAttrs: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Attribute names to omit from attrs output in attr/json modes (e.g. ["class","style"] to cut Tailwind noise).',
      },
      styleProps: {
        type: 'array',
        items: { type: 'string' },
        description: 'For mode=styles: computed-style props to return (omit = common layout props).',
      },
      limit: {
        type: 'number',
        description: 'Max elements to process (default 10).',
      },
      maxChars: {
        type: 'number',
        description: 'Hard per-element char cap on text/html/outer (default 4000). Sets truncated=true.',
      },
      strip: {
        type: 'array',
        items: { type: 'string' },
        description: 'Selectors removed before text/html extraction (default script,style).',
      },
      maxDepth: {
        type: 'number',
        description: 'For mode=outline: tree depth (default 3).',
      },
    },
  },
};

// Runs in the page. Single object arg = arguments[0]. Returns a JSON string.
const QUERY_DOM_SCRIPT = `
const p = arguments[0] || {};
const selector = p.selector || null;
const mode = p.mode || (selector ? 'text' : 'outline');
const limit = typeof p.limit === 'number' ? p.limit : 10;
const maxChars = typeof p.maxChars === 'number' ? p.maxChars : 4000;
const strip = Array.isArray(p.strip) ? p.strip : ['script', 'style'];
const maxDepth = typeof p.maxDepth === 'number' ? p.maxDepth : 3;
const omit = Array.isArray(p.omitAttrs) ? p.omitAttrs : [];
let truncated = false;

function trunc(s) {
  if (typeof s !== 'string') return { v: s, t: false };
  if (s.length <= maxChars) return { v: s, t: false };
  return { v: s.slice(0, maxChars), t: true };
}
function classesOf(el) {
  const c = (el.getAttribute && el.getAttribute('class')) || '';
  const t = c.trim();
  return t ? t.split(/\\s+/) : [];
}
function stripClone(el) {
  const clone = el.cloneNode(true);
  for (let i = 0; i < strip.length; i++) {
    const nodes = clone.querySelectorAll(strip[i]);
    for (let j = 0; j < nodes.length; j++) nodes[j].remove();
  }
  return clone;
}
function normText(el) {
  return (stripClone(el).textContent || '').replace(/\\s+/g, ' ').trim();
}
function outline(root) {
  const out = [];
  function walk(el, depth, path) {
    const cls = classesOf(el);
    out.push({
      depth: depth,
      path: path,
      tag: el.tagName ? el.tagName.toLowerCase() : '?',
      id: el.id || undefined,
      classes: cls.length ? cls : undefined,
      nChildren: el.children ? el.children.length : 0,
      textLen: (el.textContent || '').length
    });
    if (depth >= maxDepth) return;
    const kids = el.children || [];
    for (let i = 0; i < kids.length; i++) {
      const tg = kids[i].tagName ? kids[i].tagName.toLowerCase() : '?';
      walk(kids[i], depth + 1, path + '>' + tg + '[' + i + ']');
    }
  }
  walk(root, 0, root.tagName ? root.tagName.toLowerCase() : 'root');
  return out;
}

const total = selector ? document.querySelectorAll(selector).length : 1;
if (mode === 'count') {
  return JSON.stringify({ mode: 'count', selector: selector, count: total });
}

let els;
if (!selector) els = [document.body];
else els = Array.prototype.slice.call(document.querySelectorAll(selector), 0, limit);

if (mode === 'outline') {
  const results = els.map(function (el) { return outline(el); });
  return JSON.stringify({ mode: 'outline', selector: selector, matched: total, maxDepth: maxDepth, results: results.length === 1 ? results[0] : results });
}

const results = [];
for (let i = 0; i < els.length; i++) {
  const el = els[i];
  const entry = { i: i, tag: el.tagName ? el.tagName.toLowerCase() : '?' };
  if (mode === 'text') {
    const r = trunc(normText(el));
    entry.text = r.v; if (r.t) { entry.truncated = true; truncated = true; }
  } else if (mode === 'html') {
    const r = trunc(stripClone(el).innerHTML);
    entry.html = r.v; if (r.t) { entry.truncated = true; truncated = true; }
  } else if (mode === 'outer') {
    const r = trunc(el.outerHTML);
    entry.outer = r.v; if (r.t) { entry.truncated = true; truncated = true; }
  } else if (mode === 'attr') {
    const spec = p.attr || '*';
    const a = {};
    if (spec === '*') {
      if (el.attributes) for (let k = 0; k < el.attributes.length; k++) { const n = el.attributes[k].name; if (omit.indexOf(n) === -1) a[n] = el.attributes[k].value; }
    } else {
      const names = spec.split(',').map(function (s) { return s.trim(); });
      names.forEach(function (n) { a[n] = el.getAttribute(n); });
    }
    entry.attrs = a;
  } else if (mode === 'styles') {
    const cs = window.getComputedStyle(el);
    const props = (Array.isArray(p.styleProps) && p.styleProps.length) ? p.styleProps :
      ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-size', 'flex', 'grid-template-columns', 'transform', 'overflow', 'z-index'];
    const s = {};
    props.forEach(function (prop) { s[prop] = cs.getPropertyValue(prop); });
    entry.styles = s;
  } else if (mode === 'table') {
    const headers = Array.prototype.map.call(el.querySelectorAll('thead th, tr:first-child th, tr:first-child td'), function (th) { return (th.textContent || '').replace(/\\s+/g, ' ').trim(); });
    const rows = [];
    const trs = el.querySelectorAll('tbody tr, tr');
    for (let r = 0; r < trs.length && rows.length < limit; r++) {
      const cells = Array.prototype.map.call(trs[r].querySelectorAll('td'), function (td) { return (td.textContent || '').replace(/\\s+/g, ' ').trim(); });
      if (cells.length) rows.push(cells);
    }
    entry.headers = headers; entry.rows = rows;
  } else if (mode === 'json') {
    const a = {};
    if (el.attributes) for (let k = 0; k < el.attributes.length; k++) { const n = el.attributes[k].name; if (omit.indexOf(n) === -1) a[n] = el.attributes[k].value; }
    const r = trunc(normText(el));
    entry.id = el.id || undefined;
    entry.attrs = a;
    entry.text = r.v; if (r.t) { entry.truncated = true; truncated = true; }
    entry.nChildren = el.children ? el.children.length : 0;
  }
  results.push(entry);
}
return JSON.stringify({ mode: mode, selector: selector, matched: total, returned: results.length, truncated: truncated, results: results });
`;

export async function handleQueryDom(args: unknown): Promise<McpToolResponse> {
  try {
    const params = (args ?? {}) as Record<string, unknown>;

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();
    const driver = firefox.getDriver();
    if (!driver) throw new Error('WebDriver not available');

    await driver.manage().setTimeouts({ script: 10000 });
    const raw = await driver.executeScript(QUERY_DOM_SCRIPT, params);

    // The injected script already returns compact JSON — pass it through.
    // Re-parsing + pretty-printing doubled the token cost for no gain.
    const output = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const response = successResponse(truncateText(output, TOKEN_LIMITS.MAX_RESPONSE_CHARS));

    // Native structured result — escape-free for clients that support MCP
    // structured output. Skipped when the payload was truncated: attaching
    // the full object would bypass the response token cap.
    if (output.length <= TOKEN_LIMITS.MAX_RESPONSE_CHARS) {
      try {
        const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          response.structuredContent = parsed as Record<string, unknown>;
        }
      } catch {
        // Non-JSON script output — text fallback only
      }
    }
    return response;
  } catch (error) {
    return errorResponse(error as Error);
  }
}
