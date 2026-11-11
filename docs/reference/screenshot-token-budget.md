---
title: Screenshot token budget
summary: what a screenshot costs an agent in tokens, the measured legibility floor, the detail levels and flags that control it, and how tall, JPEG and oversized pictures are shrunk
verified: 2026-11-11
---

# Screenshot token budget

## Cost

An image costs roughly `width × height / 750` tokens. Anthropic clients downscale anything
with a long edge above 1568 px **before** billing, so pixels past that are bytes on the wire
that nobody receives.

| viewport | size | tokens per full-size screenshot |
|---|---|---|
| phone | 390×844 | ~439 |
| tablet | 768×1024 | ~1,049 |
| laptop | 1280×720 | ~1,229 |
| desktop | 1920×1080 | ~2,765 (billed as if ~1568 wide) |

## Measured legibility

Measured by blind transcription: an agent read 27 unseen Hacker News headlines with 7–11 px
metadata text, at each long-edge size.

| `detail` | long edge | ~tokens | what was legible |
|---|---|---|---|
| `high` | 1568 | ~1,700 | everything; the practical ceiling |
| `medium` | 1024 | ~720 | every glyph, including 7 px metadata |
| *(auto default)* | 800 | ~440 | all 27 titles exact, domains readable |
| `low` | 640 | ~280 | **fails by confident misreading** of proper nouns and digits (`M3` read as `M5`), not by blur. Layout only |
| `full` | 0 | — | no downscale |

The 640 px failure is the dangerous kind: the reader does not know it is wrong.

## Two budgets

A picture the agent **asked for** (`screenshot_page`, `screenshot_by_uid`, and the images
`extract_images` returns) defaults to 1024; the set is `EXPLICIT_PICTURE_TOOLS` in
`src/index.ts`. A picture **attached unasked** to a mutation's context bundle defaults to 800, because
that one fires on every click and is where a long session actually spends its context.
Dropping auto-attached pictures from ~1,700 to ~440 tokens returns roughly 38k tokens over a
30-mutation session.

## Controls

| control | effect |
|---|---|
| `detail` argument on any image-returning tool | `low` / `medium` / `high` / `full` |
| `--screenshot-max-edge`, `FIREFOX_SCREENSHOT_MAX_EDGE` | default for explicit pictures; `0` disables |
| `--screenshot-auto-max-edge`, `FIREFOX_SCREENSHOT_AUTO_MAX_EDGE` | default for auto-attached pictures; `0` disables |
| `saveTo` | always written at full resolution, because a file costs no tokens; the copy stays on the server and is swept (see [Capturing pages and page images](capturing-pages-and-images.md)) |

`detail` is advertised only on tools that carry a context bundle, which does not include
`extract_images`. Its picked images take the explicit default unless the operator flag
changes it.

## Which edge is fitted

The budget normally caps the **long** edge. A picture more than twice as tall as it is wide
(a full-page capture, typically) has its **width** fitted instead, and the height follows:
fitting the long edge of a 1920×15,000 page to 1024 would leave it about 131 px wide and
unreadable. Viewport captures and auto-attached pictures are never that shape, so they are
unaffected.

Whatever the rule, no side leaves the server longer than 8000 px (`MAX_SIDE` in
`src/utils/image-scale.ts`): the Anthropic API rejects an image over 8000 px on either side,
and the rejection fails the whole reply, text included. The cap only runs where the
downscale runs: a budget of zero (`detail: 'full'`, or a flag set to `0`) skips both, so a
full-page capture taller than 8000 px requested at `full` reaches the client uncapped. GIF
blocks are never capped either.

## Formats

PNG blocks are decoded with `pngjs`, JPEG blocks with `jpeg-js` (pure JavaScript, no native
build) and re-encoded at quality 85; the capture's own quality setting is lost on decode.
Any other mime type, GIF included, is returned untouched.

Downscaling is an area average (`src/utils/image-scale.ts`); sharper kernels ring around
glyph edges at these ratios. Every failure path returns the original bytes.
`MAX_SCREENSHOT_CHARS` in `src/utils/response-helpers.ts` is declared but read nowhere;
screenshots are capped by area, not characters.
