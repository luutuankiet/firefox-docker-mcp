/**
 * extract_images against a running browser (Marionette on 2828), through the
 * built server over stdio.
 *
 * Opens its own tab on a data: page holding an inline <svg>, a same-origin
 * <canvas>, a data: PNG <img>, a CSS background, a tiny <img> that minSize
 * must skip, and an <img> that cannot be fetched (rendered fallback). Closes
 * only that tab.
 *
 * Run: node test/extract-images.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';

function solidPng(w, h, [r, g, b]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png).toString('base64');
}

const red = solidPng(40, 40, [220, 20, 20]);
const blue = solidPng(8, 8, [20, 20, 220]);

const html = `<!doctype html><html><head><title>extract-images test</title></head><body style="margin:20px">
<h1>images</h1>
<svg id="chart" width="120" height="80" viewBox="0 0 120 80"><title>a chart</title><rect x="10" y="10" width="100" height="60" fill="#3a7"/><text x="20" y="45">hi</text></svg>
<canvas id="pad" width="100" height="60"></canvas>
<img alt="red square" width="40" height="40" src="data:image/png;base64,${red}">
<img alt="tiny" width="10" height="10" src="data:image/png;base64,${blue}">
<div id="bg" style="width:64px;height:64px;background-image:url(data:image/png;base64,${red})"></div>
<img alt="svg file" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><rect width="60" height="30" fill="#09c"/></svg>')}">
<img alt="broken"width="50" height="50" src="http://127.0.0.1:9/nothing.png">
<script>const c=document.getElementById('pad').getContext('2d');c.fillStyle='#f80';c.fillRect(0,0,100,60);</script>
</body></html>`;
const url = 'data:text/html;base64,' + Buffer.from(html).toString('base64');

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

const pngSize = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
};

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--connect-existing', '--marionette-port', '2828'],
});
const client = new Client({ name: 'extract-images-test', version: '0.1.0' });

let agent = null;
let tab = null;

const call = async (name, args = {}) => {
  const res = await client.callTool({
    name,
    arguments: { ...(agent ? { agent } : {}), ...(tab ? { tab } : {}), ...args },
  });
  return res.content || [];
};
const texts = (content) => content.filter((c) => c.type === 'text').map((c) => c.text);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  check(tools.some((t) => t.name === 'extract_images'), 'extract_images is registered');

  const opened = await call('new_page', { url });
  const env = texts(opened).join('\n');
  const m = /── (\S+) · tab (\S+)/.exec(env);
  if (!m) throw new Error(`could not read agent/tab from new_page envelope:\n${env}`);
  agent = m[1];
  tab = m[2];
  console.log(`agent ${agent}, tab ${tab}`);

  try {
    // ---- list mode
    const listed = await call('extract_images');
    const listText = texts(listed)[0] ?? '';
    console.log('\n--- list mode\n' + listText + '\n');
    check(listed.every((c) => c.type === 'text'), 'list mode returns text only');
    const lines = listText.split('\n').filter((l) => /^\[\d+\] /.test(l));
    const find = (re) => lines.find((l) => re.test(l));
    const svgLine = find(/^\[\d+\] svg /);
    const canvasLine = find(/^\[\d+\] canvas /);
    const imgLine = find(/^\[\d+\] img .*alt="red square"/);
    const bgLine = find(/^\[\d+\] background /);
    const brokenLine = find(/alt="broken"/);
    const svgFileLine = find(/alt="svg file"/);
    check(Boolean(svgLine) && /120x80/.test(svgLine) && /id=chart/.test(svgLine), 'list shows the inline svg');
    check(Boolean(canvasLine) && /100x60/.test(canvasLine), 'list shows the canvas');
    check(Boolean(imgLine) && Boolean(bgLine) && Boolean(brokenLine), 'list shows img, background and broken img');
    check(!find(/alt="tiny"/), 'minSize 24 skips the 10x10 img');
    check(!/base64,/.test(listText) && /KB inline/.test(listText), 'data: URLs are described, not copied');
    check(/visible/.test(svgLine ?? ''), 'visibility flag present');

    const idx = (line) => Number(/^\[(\d+)\]/.exec(line)[1]);

    // ---- pick mode: spec check 5, svg + canvas
    const picked = await call('extract_images', { pick: [idx(svgLine), idx(canvasLine)] });
    const imgs = picked.filter((c) => c.type === 'image');
    const pickLines = texts(picked).filter((t) => /^\[\d+\] /.test(t));
    console.log('--- pick svg+canvas\n' + pickLines.join('\n') + '\n');
    check(imgs.length === 2 && imgs.every((i) => i.mimeType === 'image/png'), 'pick returns two PNG image blocks');
    check(pickLines.length === 2 && pickLines.every((l) => /source: original/.test(l)), 'both say source: original');
    check(picked[0]?.type === 'text' && picked[1]?.type === 'image', 'text line precedes its image');
    const svgSize = pngSize(imgs[0]?.data ?? '');
    const canvasSize = pngSize(imgs[1]?.data ?? '');
    console.log('svg png', svgSize, 'canvas png', canvasSize);
    check(svgSize && svgSize.w === 240 && svgSize.h === 160, 'svg rasterized at scale 2 (240x160)');
    check(canvasSize && canvasSize.w === 100 && canvasSize.h === 60, 'canvas comes back at its own size');

    // ---- pick mode: img, background, broken (rendered fallback), missing index
    const more = await call('extract_images', {
      pick: [idx(imgLine), idx(bgLine), idx(brokenLine), 999],
    });
    const moreLines = texts(more).filter((t) => /^\[\d+\] /.test(t));
    const moreImgs = more.filter((c) => c.type === 'image');
    console.log('--- pick img+bg+broken+999\n' + moreLines.join('\n') + '\n');
    check(/source: original/.test(moreLines[0] ?? '') && /src=data:image\/png/.test(moreLines[0] ?? ''), 'data: img is original and repeats src');
    check(/source: original/.test(moreLines[1] ?? ''), 'background is original');
    check(/source: rendered/.test(moreLines[2] ?? ''), 'unfetchable img falls back to rendered');
    check(/^\[999\] not found/.test(moreLines[3] ?? ''), 'out-of-range index is reported');
    check(moreImgs.length === 3, 'three image blocks for three found picks');
    const redSize = pngSize(moreImgs[0]?.data ?? '');
    check(redSize && redSize.w === 40 && redSize.h === 40, 'original img bytes are the 40x40 PNG');
    check(!moreLines.some((t) => /base64,/.test(t)), 'no base64 in any image text line');

    // ---- an SVG file in an <img> leaves as PNG, never as SVG
    const conv = await call('extract_images', { pick: [idx(svgFileLine)] });
    const convLine = texts(conv).find((t) => /^\[\d+\] /.test(t)) ?? '';
    const convImg = conv.find((c) => c.type === 'image');
    console.log('--- pick svg file\n' + convLine + '\n');
    check(/source: original \(converted from image\/svg\+xml\)/.test(convLine), 'svg file is converted, labelled original');
    const convSize = pngSize(convImg?.data ?? '');
    check(convImg?.mimeType === 'image/png' && convSize?.w === 120 && convSize?.h === 60, 'svg file rasterized to PNG at scale 2');

    // ---- argument checks
    const tooMany = await call('extract_images', { pick: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    check(/at most 10/.test(texts(tooMany).join('\n')), 'more than 10 picks is refused');

    const scoped = await call('extract_images', { selector: '#bg' });
    const scopedText = texts(scoped)[0] ?? '';
    check(/^1 image /.test(scopedText) && /background/.test(scopedText), 'selector scopes the list');
  } finally {
    const closed = await call('close_page');
    console.log('\nclose_page:', texts(closed)[0]?.split('\n')[0]);
  }
} catch (err) {
  console.error('Test error:', err?.stack || err);
  failures.push('exception');
} finally {
  await client.close().catch(() => {});
}

if (failures.length) {
  console.log(`\n❌ ${failures.length} failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\n✅ extract_images: all checks passed');
