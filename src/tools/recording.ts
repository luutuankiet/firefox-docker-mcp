/**
 * start_recording / stop_recording — screenshot-polling screen capture.
 *
 * Firefox exposes no BiDi screencast and geckodriver can't reach Playwright's
 * private Juggler video protocol, so a setInterval screenshot loop is the only
 * portable path. Frames + wall-clock timestamps buffer in memory; stop writes
 * PNG frames + a gifenc-encoded GIF to disk and returns evenly-sampled frames
 * as ImageContent for inline agent viewing (the MCP proxy passes image blocks
 * through byte-for-byte). While recording, the per-call auto-screenshot is
 * suppressed via isRecording() to avoid Marionette contention + duplicate tokens.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
// gifenc + pngjs are CJS and stay external (see tsup.config external/noExternal).
// Load via createRequire so Node resolves them as CommonJS without ESM named-import
// interop failures; the non-`require` binding name keeps esbuild from rewriting it.
const nodeRequire = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = nodeRequire('gifenc') as typeof import('gifenc');
const { PNG } = nodeRequire('pngjs') as typeof import('pngjs');
import { successResponse, errorResponse } from '../utils/response-helpers.js';
import type { McpToolResponse, McpContentItem } from '../types/common.js';

interface Frame {
  data: Buffer;
  ts: number;
}

interface RecordingState {
  active: boolean;
  frames: Frame[];
  startTs: number;
  fps: number;
  maxFrames: number;
  maxDurationMs: number;
  timer: ReturnType<typeof setInterval> | null;
  capturing: boolean;
}

const FRAME_CAP = 120;
const FPS_CAP = 4;
const DURATION_CAP = 60;
const RECORDINGS_DIR = path.join(os.homedir(), '.firefox-devtools-mcp', 'recordings');

let recording: RecordingState | null = null;

/** True while a recording is capturing — index.ts uses this to suppress the
 *  per-mutation auto-screenshot so it doesn't fight the capture loop. */
export function isRecording(): boolean {
  return recording !== null && recording.active;
}

export const startRecordingTool = {
  name: 'start_recording',
  description:
    'Start a screen recording via screenshot polling. Buffers frames + timestamps in memory and suppresses per-call auto-screenshots while active. Auto-stops at the frame cap (120) or maxDurationSec. Call stop_recording to retrieve frames + a GIF.',
  inputSchema: {
    type: 'object',
    properties: {
      fps: { type: 'number', description: 'Frames per second (default 2, cap 4).' },
      maxDurationSec: {
        type: 'number',
        description: 'Auto-stop after N seconds (default 30, cap 60).',
      },
    },
  },
};

export async function handleStartRecording(args: unknown): Promise<McpToolResponse> {
  try {
    if (recording && recording.active) {
      return errorResponse(new Error('A recording is already in progress. Call stop_recording first.'));
    }
    const p = (args ?? {}) as { fps?: number; maxDurationSec?: number };
    const fps = Math.min(Math.max(p.fps ?? 2, 0.5), FPS_CAP);
    const maxDurationSec = Math.min(Math.max(p.maxDurationSec ?? 30, 1), DURATION_CAP);
    const intervalMs = Math.round(1000 / fps);

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    const state: RecordingState = {
      active: true,
      frames: [],
      startTs: Date.now(),
      fps,
      maxFrames: FRAME_CAP,
      maxDurationMs: maxDurationSec * 1000,
      timer: null,
      capturing: false,
    };
    recording = state;

    const tick = async () => {
      if (!state.active || state.capturing) return;
      state.capturing = true;
      try {
        const b64 = await firefox.takeScreenshotPage();
        if (b64 && typeof b64 === 'string') {
          state.frames.push({ data: Buffer.from(b64, 'base64'), ts: Date.now() });
        }
      } catch {
        // drop this frame, keep recording
      } finally {
        state.capturing = false;
      }
      const elapsed = Date.now() - state.startTs;
      if (state.frames.length >= state.maxFrames || elapsed >= state.maxDurationMs) {
        state.active = false;
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
      }
    };

    state.timer = setInterval(() => {
      void tick();
    }, intervalMs);

    return successResponse(
      `✅ recording started — ${fps} fps, auto-stop at ${state.maxFrames} frames or ${maxDurationSec}s. ` +
        'Per-call auto-screenshots are suppressed while recording. Call stop_recording to retrieve.'
    );
  } catch (error) {
    recording = null;
    return errorResponse(error as Error);
  }
}

export const stopRecordingTool = {
  name: 'stop_recording',
  description:
    'Stop the active recording. Writes PNG frames + a GIF to ~/.firefox-devtools-mcp/recordings/<ts>/ and returns a timing summary + N evenly-sampled frames as inline images. Read additional frames via fs-mcp read_files on the frame-NNN.png paths.',
  inputSchema: {
    type: 'object',
    properties: {
      returnFrames: {
        type: 'number',
        description: 'Number of evenly-sampled frames to return inline (default 4).',
      },
      saveGif: { type: 'boolean', description: 'Encode + save recording.gif (default true).' },
    },
  },
};

export async function handleStopRecording(args: unknown): Promise<McpToolResponse> {
  try {
    if (!recording) {
      return errorResponse(new Error('No recording in progress. Call start_recording first.'));
    }
    const p = (args ?? {}) as { returnFrames?: number; saveGif?: boolean };
    const returnFrames = Math.max(1, p.returnFrames ?? 4);
    const saveGif = p.saveGif !== false;

    const state = recording;
    state.active = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    recording = null;

    const frames = state.frames;
    if (frames.length === 0) {
      return errorResponse(new Error('Recording captured 0 frames (page may not have loaded). Nothing to save.'));
    }

    const durationMs = frames[frames.length - 1]!.ts - frames[0]!.ts;
    const achievedFps = durationMs > 0 ? (frames.length - 1) / (durationMs / 1000) : frames.length;

    const dirName = new Date(state.startTs).toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(RECORDINGS_DIR, dirName);
    await fs.mkdir(outDir, { recursive: true });

    const framePaths: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const name = `frame-${String(i).padStart(3, '0')}.png`;
      const fp = path.join(outDir, name);
      await fs.writeFile(fp, frames[i]!.data);
      framePaths.push(fp);
    }

    let gifPath: string | null = null;
    let gifSize = 0;
    if (saveGif) {
      try {
        const gifBytes = encodeGif(frames);
        gifPath = path.join(outDir, 'recording.gif');
        await fs.writeFile(gifPath, gifBytes);
        gifSize = gifBytes.length;
      } catch {
        gifPath = null; // GIF is best-effort; the PNG frames are the durable artifact
      }
    }

    const n = Math.min(returnFrames, frames.length);
    const sampleIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      sampleIdx.push(Math.round((i * (frames.length - 1)) / Math.max(1, n - 1)));
    }
    const uniqueIdx = Array.from(new Set(sampleIdx));

    const portalRel = path.relative(os.homedir(), outDir);
    const t0 = frames[0]!.ts;
    const timing = frames
      .map((f, i) => `  frame-${String(i).padStart(3, '0')}  +${((f.ts - t0) / 1000).toFixed(2)}s`)
      .join('\n');

    let summary =
      '✅ recording stopped\n' +
      `frames: ${frames.length} | duration: ${(durationMs / 1000).toFixed(2)}s | achieved: ${achievedFps.toFixed(2)} fps (target ${state.fps})\n` +
      `disk: ${outDir}\n` +
      `fs-mcp readback: read_files on ${portalRel}/frame-NNN.png (images ≤5MB → ImageContent)\n`;
    if (gifPath) {
      const gifWarn =
        gifSize > 5 * 1024 * 1024
          ? '  ⚠️ >5MB — too large for fs-mcp ImageContent readback, view on host'
          : '';
      summary += `gif: ${gifPath} (${(gifSize / 1024).toFixed(0)} KB)${gifWarn}\n`;
      summary +=
        'note: an animated GIF read by a model = first frame only. The GIF is the HUMAN artifact; the PNG frames are the AGENT artifact.\n';
    }
    summary +=
      `\ntiming:\n${timing}\n\nreturning ${uniqueIdx.length} sampled frame(s) inline: ` +
      uniqueIdx.map((i) => `frame-${String(i).padStart(3, '0')}`).join(', ');

    const content: McpContentItem[] = [{ type: 'text', text: summary }];
    for (const i of uniqueIdx) {
      content.push({ type: 'image', data: frames[i]!.data.toString('base64'), mimeType: 'image/png' });
    }

    return { content };
  } catch (error) {
    return errorResponse(error as Error);
  }
}

function encodeGif(frames: Frame[]): Buffer {
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const png = PNG.sync.read(frames[i]!.data);
    const rgba = new Uint8Array(png.data);
    const palette = quantize(rgba, 256, { format: 'rgb565' });
    const index = applyPalette(rgba, palette, 'rgb565');
    const delay = i < frames.length - 1 ? Math.max(20, frames[i + 1]!.ts - frames[i]!.ts) : 100;
    const opts = i === 0 ? { palette, delay, repeat: 0 } : { palette, delay };
    gif.writeFrame(index, png.width, png.height, opts);
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}
