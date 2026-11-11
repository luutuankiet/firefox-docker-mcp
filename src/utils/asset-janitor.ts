/**
 * Expiry for the files the server leaves behind.
 *
 * Screenshots, recording frames and browser logs exist to answer the tool call
 * that produced them. Once that answer has been read they are dead weight, but
 * nothing ever deleted them - a long-lived container accumulated every frame of
 * every recording it had ever made until the disk filled.
 *
 * Everything the server writes lands in a directory it owns, and every one of
 * those is swept. That includes a screenshot's `saveTo`: the caller's path is no
 * longer honoured, only its base name, inside the screenshots folder below. The
 * caller's path usually named a directory on the caller's own machine, which the
 * server cannot reach, so files written there were never read and never removed.
 */

import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ASSET_ROOT = join(homedir(), '.firefox-devtools-mcp');

/** Where `saveTo` copies of screenshots go. */
export const SCREENSHOT_DIR = join(ASSET_ROOT, 'screenshots');

// Everything the server writes.
const MANAGED_DIRS = [join(ASSET_ROOT, 'recordings'), join(ASSET_ROOT, 'output'), SCREENSHOT_DIR];

const DEFAULT_TTL_MIN = 60;

/** Minutes a written file survives; zero, negative or unparseable means cleanup is off. */
export function assetTtlMinutes(): number {
  return Number(process.env.MCP_ASSET_TTL_MIN ?? DEFAULT_TTL_MIN);
}
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Delete everything under a directory that has not been touched recently.
 *
 * Entries are judged by modification time rather than creation time so a
 * recording still being written keeps resetting its own clock and cannot be
 * collected out from under itself.
 */
async function sweepDirectory(dir: string, ttlMs: number): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // The directory only appears once the feature that writes to it is used.
    return 0;
  }

  const cutoff = Date.now() - ttlMs;
  let removed = 0;

  for (const entry of entries) {
    const target = join(dir, entry);
    try {
      const info = await stat(target);
      if (info.mtimeMs >= cutoff) {
        continue;
      }
      await rm(target, { recursive: true, force: true });
      removed++;
    } catch {
      // Raced with another sweep or with the writer; the next pass will retry.
    }
  }

  return removed;
}

/**
 * Sweep once, then keep sweeping.
 *
 * The first pass runs immediately because a container that restarts often would
 * otherwise never reach its first interval, and those are exactly the runs that
 * leave debris behind.
 *
 * A ttl of zero turns collection off, for anyone who wants to keep the frames.
 */
export function startAssetJanitor(
  ttlMinutes: number = assetTtlMinutes(),
  log: (message: string) => void = () => {}
): void {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    log('Asset cleanup disabled; recordings and browser logs will be kept.');
    return;
  }

  const ttlMs = ttlMinutes * 60 * 1000;

  const sweep = async (): Promise<void> => {
    let removed = 0;
    for (const dir of MANAGED_DIRS) {
      removed += await sweepDirectory(dir, ttlMs);
    }
    if (removed > 0) {
      log(`Cleaned up ${removed} asset(s) older than ${ttlMinutes}m.`);
    }
  };

  void sweep();

  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  // Housekeeping should never be the reason the process stays alive.
  timer.unref();
}
