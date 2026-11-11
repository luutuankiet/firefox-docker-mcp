---
title: Capturing pages and page images
summary: what screenshot_page, screenshot_by_uid and extract_images can capture, where Firefox cuts a long page, what original and rendered mean, and where saveTo copies go and when they are deleted
verified: 2026-11-11
---

# Capturing pages and page images

Three read-only tools return pictures: `screenshot_page`, `screenshot_by_uid` and
`extract_images`. All three hand back MCP image blocks. Moving a file onto the caller's
disk is the caller's job; the server never offers to do it.

## What `screenshot_page` captures

| argument | capture |
|---|---|
| none | the visible viewport, PNG; the same request the tool made before these options existed |
| `fullPage: true` | the whole document, `origin: 'document'` |
| `clip: {x, y, width, height}` | a box in document CSS pixels, measured from the top-left of the document |
| `selector` | the first element matching a CSS selector, clipped to that element |
| `format: 'jpeg'`, `quality` (0 to 1, default 0.8) | JPEG instead of PNG; the image block's mime type follows |

`fullPage`, `clip` and `selector` are mutually exclusive. `screenshot_by_uid` takes
exactly one of `uid` or `selector`, plus `format` and `quality`. A selector that matches
more than one element captures the first and says so in a text block; no match is an
error naming the selector.

Handlers: `src/tools/screenshot.ts`. Capture options are passed through
`screenshotTab(tabId, options)` in `src/firefox/index.ts` to `screenshotContext` in
`src/firefox/bidi-ops.ts`.

## Every option above needs BiDi

A region, a selector or JPEG is captured over WebDriver BiDi, addressed to the tab by its
context, so the tab is never raised. If BiDi is down the call fails with a text error. It
never falls back to the WebDriver classic capture, because that one can only photograph
the viewport of the focused tab and would quietly answer a different question. Only the
plain viewport PNG keeps the classic fallback.

## Where Firefox cuts a long page

One capture is limited to 32,767 **device** pixels per side and 472,907,776 device pixels
of area (`MAX_CANVAS_SIDE`, `MAX_CANVAS_AREA` in `src/tools/screenshot.ts`, the values
Firefox's own capture code checks). Before a `fullPage` capture the server reads
`scrollWidth`, `scrollHeight` and `devicePixelRatio` from the page and divides both limits
by the ratio, so at ratio 1 the cut lands at CSS `y = 32767`; at ratio 2 it lands near
16,383. The area limit can cut a very wide page earlier than the side limit.

When anything is cut, a text block gives the real size, where the capture stopped, and the
exact `clip` to request next. The same clamp applies to a `clip` box. Without that text a
picture that ends halfway down a page reads as a page that ends there.

## `extract_images`

Read-only, never raises the tab, writes nothing into the page.

- **List mode** (no `pick`): text only, one line per image in document order:
  `[index] kind WxH visibility [natural WxH] src= id= alt=`. Kinds are `img`, `svg`,
  `canvas` and `background` (a CSS `background-image` URL). Visibility is `visible`,
  `offscreen` or `hidden`. `minSize` (default 24) drops images smaller than that in both
  CSS dimensions; `selector` limits the search to matching elements. At most 200 lines;
  the rest are counted.
- **Pick mode** (`pick: [indexes]`, at most 10): re-runs the same enumeration, then
  returns per index one text line (the list line plus a `source:` label) and one image
  block. An index past the end says the page changed and to list again.

| label | meaning |
|---|---|
| `source: original` | the page's own bytes: `img` and `background` fetched from their URL; WebP, AVIF and SVG files redrawn to PNG; inline `svg` rasterised at `scale` (default 2, max 8) over white; `canvas` read with `toDataURL` |
| `source: rendered` | the original could not be read (cross-origin without CORS, a tainted canvas, a decode error), so the element was photographed instead, as `screenshot_by_uid` would |

Only PNG or JPEG ever leaves the tool; a GIF is redrawn as PNG so it can be downscaled. Indexes are not stable across page changes;
the `src=` in each picked line is there so the caller can check it got the image it meant.

"Original" describes where the pixels came from, not their size: picked PNG and JPEG
blocks go through the same downscale as screenshots (see
[Screenshot token budget](screenshot-token-budget.md)).

## `saveTo` writes a short-lived copy on the server

`saveTo` returns text instead of an image. Only the base name of the given path is used,
stripped to `[A-Za-z0-9._-]`, with a timestamp prefix and an extension that follows
`format`:

```
~/.firefox-devtools-mcp/screenshots/<timestamp>-<name>.png
```

That folder is inside the server's container. If the caller named a different directory,
the reply says it was not used. The file is written at full resolution, because a file
costs no image tokens.

Since 0.11.0 the asset janitor (`src/utils/asset-janitor.ts`) sweeps this folder along
with `recordings/` and `output/`. Anything older than `MCP_ASSET_TTL_MIN` minutes by
modification time is deleted (default 60; the production compose file sets 60; zero or
less turns cleanup off). It sweeps once at startup and then every 15 minutes, so a file
can outlive its TTL by up to one interval. Before 0.11.0 the caller's path was honoured
inside the container and never swept: production collected those files in its writable
layer until a container recreate.
