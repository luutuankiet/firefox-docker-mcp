/**
 * Screenshot text boxes (textBoxes: true): coordinates in the returned image's
 * pixels, at devicePixelRatio 1 and 2, inline (possibly downscaled) and saved
 * with a sidecar file (full resolution), plus hidden, offscreen, clipped and
 * covered text left out, and the element offset of screenshot_by_uid.
 *
 * Same harness as screenshot-capture.mjs: a stdio client spawning the built
 * server against a browser with Marionette on 2828, one tab of its own.
 *
 * Run: node test/text-boxes.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const CALL_TIMEOUT_MS = 180_000;
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--connect-existing', '--marionette-port', '2828'],
});
const client = new Client({ name: 'text-boxes-test', version: '0.1.0' });
const ctx = { agent: undefined, tab: undefined };
let failed = 0;

async function call(name, args = {}) {
  const res = await client.callTool(
    { name, arguments: { ...args, ...(ctx.agent ? { agent: ctx.agent } : {}), ...(ctx.tab ? { tab: ctx.tab } : {}) } },
    undefined,
    { timeout: CALL_TIMEOUT_MS }
  );
  const content = res.content ?? [];
  return {
    isError: Boolean(res.isError),
    content,
    text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    images: content.filter((c) => c.type === 'image'),
  };
}

function page(html) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
}

const T = 'position:absolute;font:20px/20px monospace;margin:0;white-space:nowrap';
const FIXTURE = page(`
<div style="${T};left:40px;top:30px">Alpha beta</div>
<div style="${T};left:300px;top:200px">Gamma</div>
<div style="${T};left:40px;top:250px;visibility:hidden">HiddenVis</div>
<div style="${T};left:40px;top:280px;display:none">HiddenNone</div>
<div style="${T};left:40px;top:310px;opacity:0">HiddenOpacity</div>
<div style="${T};left:40px;top:1500px">Offscreen</div>
<div style="${T};left:40px;top:400px;width:50px;height:20px;overflow:hidden"><span style="margin-left:200px">Clipped</span></div>
<div style="${T};left:40px;top:500px">Covered</div>
<div style="position:absolute;left:30px;top:490px;width:200px;height:40px;background:#fff;z-index:5"></div>
<div id="card" style="position:absolute;left:500px;top:100px;width:300px;height:80px;border:1px solid #888">
  <div style="${T};left:20px;top:30px">Card text</div>
</div>
<div style="height:1600px"></div>`);

/** Parse the text block that holds the boxes; it must parse on its own. */
function boxesBlock(res) {
  const blocks = res.content.filter((c) => c.type === 'text' && c.text.startsWith('{"width":'));
  if (blocks.length !== 1) throw new Error(`expected one boxes block, got ${blocks.length}: ${res.text.slice(0, 300)}`);
  return JSON.parse(blocks[0].text);
}

function pngSize(b64) {
  const b = Buffer.from(b64, 'base64');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function find(payload, text) {
  return payload.boxes.find((b) => b.text === text);
}

function near(actual, expected, tol, what) {
  if (Math.abs(actual - expected) > tol) throw new Error(`${what}: ${actual}, expected ${expected} +-${tol}`);
}

/** Dark pixels inside a box of a decoded PNG: text is black on white. */
function darkPixels(png, b) {
  let n = 0;
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const i = (y * png.width + x) << 2;
      if (png.data[i] < 128 && png.data[i + 1] < 128 && png.data[i + 2] < 128) n++;
    }
  }
  return n;
}

function checkExclusions(payload, offscreenExpected) {
  for (const t of ['HiddenVis', 'HiddenNone', 'HiddenOpacity', 'Clipped', 'Covered']) {
    if (payload.boxes.some((b) => b.text.includes(t))) throw new Error(`${t} should be excluded`);
  }
  const off = payload.boxes.some((b) => b.text === 'Offscreen');
  if (off !== offscreenExpected) throw new Error(`Offscreen present=${off}, expected ${offscreenExpected}`);
}

const CHECKS = [];
for (const dpr of [1, 2]) {
  CHECKS.push({
    name: `dpr ${dpr}: viewport inline, boxes match the returned image`,
    async run() {
      const vp = await call('set_viewport_size', { width: 1000, height: 700, devicePixelRatio: dpr });
      if (vp.isError) throw new Error(vp.text);
      const nav = await call('navigate_page', { url: FIXTURE });
      if (nav.isError) throw new Error(nav.text);
      const res = await call('screenshot_page', { textBoxes: true });
      if (res.isError) throw new Error(res.text);
      const p = boxesBlock(res);
      const img = pngSize(res.images[0].data);
      if (p.width !== img.width || p.height !== img.height) throw new Error(`payload ${p.width}x${p.height} vs image ${img.width}x${img.height}`);
      const s = img.width / 1000; // returned px per CSS px (dpr, then any downscale)
      const ab = find(p, 'Alpha beta');
      if (!ab) throw new Error(`"Alpha beta" not one line: ${JSON.stringify(p.boxes.slice(0, 4))}`);
      near(ab.x, 40 * s, 2, 'Alpha x');
      near(ab.y, 30 * s, 2 + 2 * s, 'Alpha y');
      const g = find(p, 'Gamma');
      near(g.x, 300 * s, 2, 'Gamma x');
      near(g.y, 200 * s, 2 + 2 * s, 'Gamma y');
      near(g.w, 60 * s, 4 * s + 2, 'Gamma w'); // 5 monospace chars at 20px ~ 60px
      checkExclusions(p, false);
      return `${p.boxes.length} boxes, image ${img.width}x${img.height}, Gamma ${JSON.stringify(g)}`;
    },
  });
  CHECKS.push({
    name: `dpr ${dpr}: fullPage saveTo writes a full-resolution sidecar, boxes land on ink`,
    async run() {
      const res = await call('screenshot_page', { fullPage: true, textBoxes: true, saveTo: 'tb.png' });
      if (res.isError) throw new Error(res.text);
      const imgPath = res.text.match(/saved on the server at (\S+\.png)/)?.[1];
      const sidecar = res.text.match(/Text boxes \(\d+\) saved on the server at (\S+)\./)?.[1];
      if (!imgPath || sidecar !== `${imgPath}.boxes.json`) throw new Error(`paths: ${res.text}`);
      const p = JSON.parse(readFileSync(sidecar, 'utf8'));
      const png = PNG.sync.read(readFileSync(imgPath));
      if (p.width !== png.width || p.height !== png.height) throw new Error('sidecar size != image size');
      near(png.width, 1000 * dpr, 20 * dpr, 'full-res width'); // scrollbar may be excluded
      const g = find(p, 'Gamma');
      near(g.x, 300 * dpr, 2, 'Gamma x');
      checkExclusions(p, true);
      for (const t of ['Alpha beta', 'Gamma', 'Offscreen', 'Card text']) {
        const b = find(p, t);
        if (!b || darkPixels(png, b) < 10 * dpr) throw new Error(`no ink inside box for ${t}`);
      }
      return `sidecar ${p.boxes.length} boxes, image ${png.width}x${png.height}`;
    },
  });
  CHECKS.push({
    name: `dpr ${dpr}: screenshot_by_uid boxes are relative to the element`,
    async run() {
      const res = await call('screenshot_by_uid', { selector: '#card', textBoxes: true });
      if (res.isError) throw new Error(res.text);
      const p = boxesBlock(res);
      const img = pngSize(res.images[0].data);
      if (p.width !== img.width) throw new Error('payload width != image width');
      const s = img.width / 302; // 300 + 2px border
      const c = find(p, 'Card text');
      if (!c || p.boxes.length !== 1) throw new Error(`boxes: ${JSON.stringify(p.boxes)}`);
      near(c.x, 21 * s, 2, 'Card x'); // 1px border + 20px
      near(c.y, 31 * s, 2 + 2 * s, 'Card y');
      return JSON.stringify(c);
    },
  });
}

try {
  await client.connect(transport);
  const opened = await call('new_page', { url: page('<h1>text-boxes test</h1>'), context: 'off' });
  if (opened.isError) throw new Error(`new_page failed: ${opened.text}`);
  const env = opened.text.match(/── (\S+) · tab (\S+)/);
  if (!env) throw new Error(`could not read agent and tab from envelope:\n${opened.text}`);
  ctx.agent = env[1];
  ctx.tab = env[2];
  console.log(`own tab ${ctx.tab} as ${ctx.agent}`);
  for (const [i, check] of CHECKS.entries()) {
    try {
      console.log(`✅ ${i + 1}. ${check.name} - ${await check.run()}`);
    } catch (err) {
      failed++;
      console.log(`❌ ${i + 1}. ${check.name} - ${err.message}`);
    }
  }
} catch (err) {
  failed++;
  console.error('Test error:', err.message || err);
} finally {
  if (ctx.tab) {
    const closed = await call('close_page', {}).catch((e) => ({ isError: true, text: String(e) }));
    if (closed.isError) console.log(`⚠️ could not close own tab ${ctx.tab}: ${closed.text.slice(0, 200)}`);
  }
  await client.close().catch(() => {});
}
console.log(failed ? `${failed} check(s) failed` : 'all text-box checks passed');
process.exit(failed ? 1 : 0);
