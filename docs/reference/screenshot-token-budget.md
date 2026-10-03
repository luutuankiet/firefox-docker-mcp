---
title: Screenshot token budget
summary: what a screenshot costs an agent in tokens, the measured legibility floor, and the detail levels and flags that control it
verified: 2026-10-03
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

A picture the agent **asked for** (`screenshot_page`, `screenshot_by_uid`) defaults to
1024. A picture **attached unasked** to a mutation's context bundle defaults to 800, because
that one fires on every click and is where a long session actually spends its context.
Dropping auto-attached pictures from ~1,700 to ~440 tokens returns roughly 38k tokens over a
30-mutation session.

## Controls

| control | effect |
|---|---|
| `detail` argument on any image-returning tool | `low` / `medium` / `high` / `full` |
| `--screenshot-max-edge`, `FIREFOX_SCREENSHOT_MAX_EDGE` | default for explicit pictures; `0` disables |
| `--screenshot-auto-max-edge`, `FIREFOX_SCREENSHOT_AUTO_MAX_EDGE` | default for auto-attached pictures; `0` disables |
| `saveTo` | always written at full resolution — a file costs no tokens |

Downscaling is an area average (`src/utils/image-scale.ts`); sharper kernels ring around
glyph edges at these ratios. Every failure path returns the original bytes.
`MAX_SCREENSHOT_CHARS` in `src/utils/response-helpers.ts` is declared but read nowhere;
screenshots are capped by area, not characters.
