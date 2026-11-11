/**
 * Screenshot capture options: fullPage, clip, selector, JPEG, saveTo, and the
 * tall-page cut. Built like test-e2e.mjs - a stdio client spawning the built
 * server against a running browser with Marionette on 2828.
 *
 * Opens one tab of its own with new_page, drives it with data: URLs, and closes
 * only that tab. Nothing else in the browser is touched.
 *
 * Run: node test/screenshot-capture.mjs
 *
 * Each check is one entry in CHECKS, numbered after the spec it was written
 * against. A new check is one more entry; see the marked slot for check 5.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SCREENSHOT_DIR = join(homedir(), '.firefox-devtools-mcp', 'screenshots');
// The server's default budget for a picture asked for by name.
const EXPLICIT_EDGE = 1024;
// Big captures take a while to encode, decode and shrink.
const CALL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--connect-existing', '--marionette-port', '2828'],
});
const client = new Client({ name: 'screenshot-capture-test', version: '0.1.0' });

/** Agent id and tab name, learned from the new_page envelope. */
const ctx = { agent: undefined, tab: undefined };

async function call(name, args = {}) {
  const res = await client.callTool(
    { name, arguments: { ...args, ...(ctx.agent ? { agent: ctx.agent } : {}), ...(ctx.tab ? { tab: ctx.tab } : {}) } },
    undefined,
    { timeout: CALL_TIMEOUT_MS }
  );
  const content = res.content ?? [];
  return {
    isError: Boolean(res.isError),
    text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    images: content.filter((c) => c.type === 'image'),
  };
}

function page(html) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
}

async function open(html) {
  const res = await call('navigate_page', { url: page(html), context: 'off' });
  if (res.isError) throw new Error(`navigate_page failed: ${res.text}`);
}

/** Decode an image block to its pixel size, whatever its encoding. */
function size(block) {
  const buf = Buffer.from(block.data, 'base64');
  if (block.mimeType === 'image/png') {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, buf };
  }
  if (block.mimeType === 'image/jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, buf };
  }
  throw new Error(`unexpected mime ${block.mimeType}`);
}

function oneImage(res, label) {
  if (res.isError) throw new Error(`${label} errored: ${res.text}`);
  if (res.images.length !== 1) throw new Error(`${label}: expected 1 image, got ${res.images.length}`);
  return res.images[0];
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Measured once by check 2 and reused: how many capture pixels per CSS pixel.
let dpr = 1;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const CHECKS = [
  {
    id: 2,
    name: 'clip {0,0,300,200} is 300x200 times the device pixel ratio',
    async run() {
      await open('<div style="width:2000px;height:3000px;background:linear-gradient(#f80,#08f)"></div>');
      const img = oneImage(
        await call('screenshot_page', { clip: { x: 0, y: 0, width: 300, height: 200 }, detail: 'full' }),
        'clip'
      );
      const s = size(img);
      dpr = s.width / 300;
      assert(dpr > 0 && Number.isInteger(dpr * 100), `odd ratio ${dpr}`);
      assert(s.height === Math.round(200 * dpr), `clip gave ${s.width}x${s.height}, expected 300x200 at dpr ${dpr}`);
      return `${s.width}x${s.height}, dpr ${dpr}`;
    },
  },
  {
    id: 1,
    name: 'fullPage on a 5000px page is taller than the viewport; tall downscale keeps width at the budget',
    async run() {
      await open('<div style="height:5000px;background:linear-gradient(#fff,#000)">top</div>');
      const viewport = size(oneImage(await call('screenshot_page', { detail: 'full' }), 'viewport'));
      const raw = size(oneImage(await call('screenshot_page', { fullPage: true, detail: 'full' }), 'fullPage raw'));
      assert(raw.height > viewport.height, `full page ${raw.height}px is not above viewport ${viewport.height}px`);
      assert(raw.height >= 5000 * dpr, `full page ${raw.height}px shorter than the 5000px body`);

      const shrunk = size(oneImage(await call('screenshot_page', { fullPage: true }), 'fullPage default'));
      const expectedWidth = Math.min(raw.width, EXPLICIT_EDGE);
      assert(shrunk.width === expectedWidth, `downscaled width ${shrunk.width}, expected ${expectedWidth}`);
      const expectedHeight = Math.round(raw.height * (expectedWidth / raw.width));
      assert(Math.abs(shrunk.height - expectedHeight) <= 1, `downscaled height ${shrunk.height}, expected ~${expectedHeight}`);
      return `viewport ${viewport.width}x${viewport.height}, raw ${raw.width}x${raw.height}, sent ${shrunk.width}x${shrunk.height}`;
    },
  },
  {
    id: 3,
    name: "format 'jpeg' returns image/jpeg starting FF D8 FF",
    async run() {
      await open('<h1>jpeg</h1><div style="height:1500px;background:linear-gradient(#0a0,#a0a)"></div>');
      for (const args of [{ format: 'jpeg' }, { format: 'jpeg', quality: 0.3, fullPage: true }]) {
        const img = oneImage(await call('screenshot_page', args), JSON.stringify(args));
        assert(img.mimeType === 'image/jpeg', `mime ${img.mimeType} for ${JSON.stringify(args)}`);
        const s = size(img);
        assert(s.buf[0] === 0xff && s.buf[1] === 0xd8 && s.buf[2] === 0xff, `bad JPEG magic ${s.buf.subarray(0, 3).toString('hex')}`);
      }
      return 'viewport and fullPage both JPEG';
    },
  },
  {
    id: 4,
    name: 'selector and uid for the same element give the same size',
    async run() {
      await open(
        '<p style="margin:40px">filler</p><button id="target" style="width:240px;height:120px;margin:30px">Press me</button><button class="dup">a</button><button class="dup">b</button>'
      );
      const snap = await call('take_snapshot', {});
      const line = snap.text.split('\n').find((l) => l.includes('Press me') && l.includes('uid='));
      assert(line, `no snapshot line for the button:\n${snap.text.slice(0, 1500)}`);
      const uid = line.match(/uid=(\S+)/)[1];

      const byUid = size(oneImage(await call('screenshot_by_uid', { uid, detail: 'full' }), 'by uid'));
      const bySel = size(oneImage(await call('screenshot_by_uid', { selector: '#target', detail: 'full' }), 'by_uid selector'));
      const byPageSel = size(oneImage(await call('screenshot_page', { selector: '#target', detail: 'full' }), 'page selector'));
      for (const [label, s] of [['by_uid selector', bySel], ['page selector', byPageSel]]) {
        assert(s.width === byUid.width && s.height === byUid.height, `${label} ${s.width}x${s.height} vs uid ${byUid.width}x${byUid.height}`);
      }

      const dup = await call('screenshot_by_uid', { selector: '.dup' });
      assert(!dup.isError && /more than one/.test(dup.text), `two matches not reported: ${dup.text.slice(0, 200)}`);
      const none = await call('screenshot_page', { selector: '#nope' });
      assert(none.isError && none.text.includes('#nope'), `missing selector not an error naming it: ${none.text.slice(0, 200)}`);
      const both = await call('screenshot_page', { selector: '#target', fullPage: true });
      assert(both.isError, 'fullPage + selector was accepted');
      return `${byUid.width}x${byUid.height} all three ways`;
    },
  },

  // ---- check 5 (extract_images: inline <svg> and same-origin <canvas>) ----
  // Belongs to the extract_images tool. Append it here as
  // { id: 5, name: '...', async run() { ... } } using open() / call() / size().

  {
    id: 6,
    name: 'saveTo lands in the swept screenshots folder, not the path given',
    async run() {
      const elsewhere = '/some/other/dir';
      assert(!existsSync(elsewhere), `${elsewhere} exists before the test; cannot tell what wrote it`);
      await open('<h1>save me</h1>');
      const res = await call('screenshot_page', { saveTo: `${elsewhere}/x.png` });
      assert(!res.isError, `saveTo errored: ${res.text}`);
      assert(res.images.length === 0, 'saveTo still returned an image block');
      const m = res.text.match(/saved on the server at (\S+) \(/);
      assert(m, `no path in reply: ${res.text.slice(0, 300)}`);
      const path = m[1];
      assert(path.startsWith(SCREENSHOT_DIR + '/'), `path ${path} not under ${SCREENSHOT_DIR}`);
      assert(path.endsWith('-x.png'), `path ${path} does not keep the base name`);
      assert(existsSync(path) && statSync(path).size > 0, `${path} not written`);
      assert(!existsSync(elsewhere), `${elsewhere} was created`);
      assert(/was not used/.test(res.text), 'reply does not say the given path was not used');
      return path;
    },
  },
  {
    id: 7,
    name: 'fullPage on a 40000px page reports the cut at 32767',
    async run() {
      await open('<div style="height:40000px;background:linear-gradient(#fff,#00f)"></div>');
      const res = await call('screenshot_page', { fullPage: true, format: 'jpeg', detail: 'low' });
      const img = oneImage(res, 'tall fullPage');
      const cut = Math.floor(32767 / dpr);
      assert(res.text.includes(`y=${cut}`), `cut at ${cut} not reported: ${res.text.slice(0, 400)}`);
      assert(/40000px tall/.test(res.text), `real height not reported: ${res.text.slice(0, 400)}`);
      assert(new RegExp(`clip \\{x: 0, y: ${cut},`).test(res.text), 'no clip hint for the rest');
      const s = size(img);
      return `cut at ${cut}; sent ${s.width}x${s.height}`;
    },
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let failed = 0;
try {
  await client.connect(transport);

  const opened = await call('new_page', { url: page('<h1>screenshot-capture test</h1>'), context: 'off' });
  if (opened.isError) throw new Error(`new_page failed: ${opened.text}`);
  const env = opened.text.match(/── (\S+) · tab (\S+)/);
  if (!env) throw new Error(`could not read agent and tab from envelope:\n${opened.text}`);
  ctx.agent = env[1];
  ctx.tab = env[2];
  console.log(`own tab ${ctx.tab} as ${ctx.agent}`);

  for (const check of CHECKS) {
    const started = Date.now();
    try {
      const detail = await check.run();
      console.log(`✅ ${check.id}. ${check.name} - ${detail} (${Date.now() - started}ms)`);
    } catch (err) {
      failed++;
      console.log(`❌ ${check.id}. ${check.name} - ${err.message}`);
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

console.log(failed ? `\n❌ ${failed} check(s) failed` : `\n✅ all ${CHECKS.length} checks passed`);
process.exit(failed ? 1 : 0);
