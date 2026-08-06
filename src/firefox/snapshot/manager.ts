/**
 * Snapshot Manager
 *
 * Snapshots are kept per tab. A snapshot describes the elements of one page, so
 * one agent taking a snapshot - or navigating - used to invalidate the uids of
 * every other agent, including agents working in tabs it had never touched.
 *
 * Snapshot ids stay unique across the whole browser, which is what lets a uid
 * name its own snapshot and therefore its own tab: the caller never has to say
 * which tab a uid came from.
 */

import { WebDriver, WebElement } from 'selenium-webdriver';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDebug } from '../../utils/logger.js';
import type { SendBiDi } from '../bidi-ops.js';
import type { Snapshot, SnapshotJson, InjectedScriptResult } from './types.js';
import { formatSnapshotTree } from './formatter.js';
import { UidResolver } from './resolver.js';

/**
 * Options for snapshot creation
 */
export interface SnapshotOptions {
  includeAll?: boolean;
  selector?: string;
}

/**
 * Runs the snapshot builder that a previous call left on the page.
 *
 * Answering null rather than throwing keeps "the page has not been prepared
 * yet" separate from "the page rejected the work", so only the first one is
 * worth sending the bundle for.
 *
 * The result comes back as text because a snapshot tree serialized as remote
 * objects is enormous and depth-limited; a string crosses the wire whole.
 */
const CALL_SNAPSHOT = `(snapshotId, optionsJson) => {
  if (typeof window.__createSnapshot !== 'function') return null;
  return JSON.stringify(window.__createSnapshot(snapshotId, JSON.parse(optionsJson)));
}`;

/**
 * Snapshot Manager
 * Uses bundled injected script for snapshot creation
 */
export class SnapshotManager {
  private driver: WebDriver;
  private sendBiDi: SendBiDi | null;
  private injectedScript: string | null = null;
  private currentSnapshotId = 0;

  // The current resolver per tab. A tab with no entry here has simply never
  // been snapshotted; that is not an error until someone presents a uid for it.
  private resolvers = new Map<string, UidResolver>();

  // The snapshots a tab had before its current one. An agent that snapshots a
  // page and then acts on it several times would otherwise lose its uids the
  // moment anything else snapshotted that tab - including the context bundle
  // riding along on its own calls. Uids expire when the page moves on, not
  // when someone looks at it again.
  private superseded = new Map<string, UidResolver[]>();

  // Two generations back: enough that a plan made from one snapshot survives
  // the snapshots taken while carrying it out, short enough that a long
  // session is not holding every uid map it ever built.
  private static readonly SUPERSEDED_KEPT = 2;

  constructor(driver: WebDriver, sendBiDi?: SendBiDi) {
    this.driver = driver;
    this.sendBiDi = sendBiDi ?? null;
  }

  /**
   * Lazy load bundled injected script
   */
  private getInjectedScript(): string {
    if (this.injectedScript) {
      return this.injectedScript;
    }

    try {
      // Get the directory where this compiled file lives (dist/)
      const currentFileUrl = import.meta.url;
      const currentFilePath = fileURLToPath(currentFileUrl);
      const currentDir = dirname(currentFilePath);

      // Try multiple potential locations
      const possiblePaths = [
        // Production: relative to bundled dist/index.js (same directory)
        resolve(currentDir, 'snapshot.injected.global.js'),
        // Development: relative to current working directory
        resolve(process.cwd(), 'dist/snapshot.injected.global.js'),
        // npx: package is in node_modules, try to find it relative to the binary
        resolve(currentDir, '../snapshot.injected.global.js'),
      ];

      const attemptedPaths: string[] = [];

      for (const path of possiblePaths) {
        attemptedPaths.push(path);
        try {
          this.injectedScript = readFileSync(path, 'utf-8');
          const sizeKB = (this.injectedScript.length / 1024).toFixed(1);
          logDebug(`✓ Loaded snapshot bundle: ${path.split('/').pop()} (${sizeKB} KB)`);
          return this.injectedScript;
        } catch {
          // Try next path
        }
      }

      throw new Error(
        `Bundle not found in any expected location. Tried paths:\n${attemptedPaths.map((p) => `  - ${p}`).join('\n')}`
      );
    } catch (error: any) {
      throw new Error(
        `Failed to load bundled snapshot script: ${error.message}. ` +
          'Make sure you have run "npm run build" to generate the bundle.'
      );
    }
  }

  /**
   * Take a snapshot of the tab the browser is currently showing.
   */
  async takeSnapshot(tabId: string, options?: SnapshotOptions): Promise<Snapshot> {
    const snapshotId = ++this.currentSnapshotId;
    logDebug(`Taking snapshot (ID: ${snapshotId}, tab: ${tabId})...`);
    const result = await this.executeInjectedScript(snapshotId, options);
    return this.record(tabId, snapshotId, result);
  }

  /**
   * Take a snapshot of a named tab, without bringing it to the front.
   *
   * Throws when the browser cannot address tabs this way, so the caller can
   * fall back to raising the tab and using the focused path.
   */
  async takeSnapshotInTab(tabId: string, options?: SnapshotOptions): Promise<Snapshot> {
    if (!this.sendBiDi) {
      throw new Error('BiDi unavailable: no command channel');
    }
    const snapshotId = ++this.currentSnapshotId;
    logDebug(`Taking snapshot in background (ID: ${snapshotId}, tab: ${tabId})...`);
    const result = await this.callInjectedScriptInTab(tabId, snapshotId, options);
    return this.record(tabId, snapshotId, result);
  }

  /**
   * File a finished capture against the tab it came from.
   *
   * The previous uids are only discarded once the new ones exist, so a snapshot
   * that fails leaves the caller with what it already had rather than nothing.
   */
  private record(tabId: string, snapshotId: number, result: InjectedScriptResult): Snapshot {
    logDebug(
      `Snapshot executeScript result: hasResult=${!!result}, hasTree=${!!result?.tree}, truncated=${result?.truncated || false}`
    );

    // Debug: log isRelevant results
    if (result?.debugLog && Array.isArray(result.debugLog)) {
      logDebug(`isRelevant debug log (${result.debugLog.length} elements checked):`);
      result.debugLog.slice(0, 20).forEach((log: any) => {
        logDebug(`  ${log.relevant ? '✓' : '✗'} ${log.el} (depth ${log.depth})`);
      });
      if (result.debugLog.length > 20) {
        logDebug(`  ... and ${result.debugLog.length - 20} more`);
      }
    }

    // Handle selector error
    if (result?.selectorError) {
      logDebug(`Snapshot generation failed: ${result.selectorError}`);
      throw new Error(result.selectorError);
    }

    if (!result?.tree) {
      const errorMsg = 'Unknown error';
      logDebug(`Snapshot generation failed: ${errorMsg}`);
      throw new Error(`Failed to generate snapshot: ${errorMsg}`);
    }

    // The outgoing uids are set aside rather than overwritten, so a uid handed
    // out a moment ago still resolves. Reusing a single resolver per tab is
    // what made every new snapshot destroy the previous one's uids.
    const previous = this.resolvers.get(tabId) ?? null;
    const resolver = new UidResolver(this.driver);
    resolver.setSnapshotId(snapshotId);
    resolver.storeUidMappings(result.uidMap);
    this.resolvers.set(tabId, resolver);
    if (previous) {
      this.supersede(tabId, previous);
    }

    // Create snapshot object
    const snapshotJson: SnapshotJson = {
      root: result.tree,
      snapshotId,
      timestamp: Date.now(),
      truncated: result.truncated || false,
      uidMap: result.uidMap,
    };

    const snapshot: Snapshot = {
      text: formatSnapshotTree(result.tree),
      json: snapshotJson,
    };

    logDebug(
      `Snapshot created: ${result.uidMap.length} elements with UIDs${result.truncated ? ' (truncated)' : ''}`
    );

    return snapshot;
  }

  /**
   * Hold on to a retired resolver for a short while, oldest evicted first.
   */
  private supersede(tabId: string, resolver: UidResolver): void {
    const kept = this.superseded.get(tabId) ?? [];
    kept.push(resolver);
    while (kept.length > SnapshotManager.SUPERSEDED_KEPT) {
      kept.shift()?.clear();
    }
    this.superseded.set(tabId, kept);
  }

  /**
   * Find the tab a uid belongs to.
   *
   * The snapshot id is carried in the uid itself, so a caller can hand back a
   * uid without remembering - or ever having been told - which tab produced it.
   */
  private resolverForUid(uid: string): UidResolver {
    const snapshotId = Number.parseInt(uid.split('_')[0] ?? '', 10);
    if (!Number.isFinite(snapshotId)) {
      throw new Error(`Invalid UID format: ${uid}`);
    }

    for (const resolver of this.resolvers.values()) {
      if (resolver.getSnapshotId() === snapshotId) {
        return resolver;
      }
    }

    // A uid from just before the newest snapshot still names an element on the
    // same page, so it is answered rather than refused. Only a uid whose page
    // has moved on, or which has aged out, reaches the error below.
    for (const kept of this.superseded.values()) {
      for (const resolver of kept) {
        if (resolver.getSnapshotId() === snapshotId) {
          return resolver;
        }
      }
    }

    throw new Error(
      `${uid} belongs to snapshot ${snapshotId}, which no longer maps to any open page. ` +
        'That page has since navigated, or has been snapshotted several times since - take a fresh snapshot of the tab you mean.'
    );
  }

  /**
   * Resolve UID to CSS selector (with staleness check)
   */
  resolveUidToSelector(uid: string): string {
    return this.resolverForUid(uid).resolveUidToSelector(uid);
  }

  /**
   * Resolve UID to its selectors, for looking the element up in a named tab
   */
  resolveUidToLocators(uid: string): { css: string; xpath?: string } {
    return this.resolverForUid(uid).resolveUidToLocators(uid);
  }

  /**
   * Resolve UID to WebElement (with staleness check and caching)
   */
  async resolveUidToElement(uid: string): Promise<WebElement> {
    return await this.resolverForUid(uid).resolveUidToElement(uid);
  }

  /**
   * Forget the uids of one tab, or of every tab when none is named.
   *
   * Navigation reaches here with the tab that navigated. Clearing all of them
   * on one page's navigation is what used to take other agents' uids with it.
   */
  clear(tabId?: string): void {
    if (tabId) {
      this.resolvers.get(tabId)?.clear();
      this.resolvers.delete(tabId);
      // Navigation is the one event that really does invalidate the older
      // generations: the elements they name are gone, so they go too.
      for (const resolver of this.superseded.get(tabId) ?? []) {
        resolver.clear();
      }
      this.superseded.delete(tabId);
      return;
    }
    for (const resolver of this.resolvers.values()) {
      resolver.clear();
    }
    this.resolvers.clear();
    for (const kept of this.superseded.values()) {
      for (const resolver of kept) {
        resolver.clear();
      }
    }
    this.superseded.clear();
  }

  /**
   * Execute bundled injected snapshot script
   */
  private async executeInjectedScript(
    snapshotId: number,
    options?: SnapshotOptions
  ): Promise<InjectedScriptResult> {
    const scriptSource = this.getInjectedScript();

    // Inject and execute the bundled script
    // The script exposes window.__createSnapshot via IIFE global
    // Guard: Only inject once, then reuse
    const result = await this.driver.executeScript<InjectedScriptResult>(
      `
      // Only inject the bundle if not already present
      if (typeof window.__createSnapshot === 'undefined') {
        ${scriptSource}
        // Register the createSnapshot function globally
        if (typeof __SnapshotInjected !== 'undefined' && __SnapshotInjected.createSnapshot) {
          window.__createSnapshot = __SnapshotInjected.createSnapshot;
        }
      }
      // Call it with options
      return window.__createSnapshot(arguments[0], arguments[1]);
      `,
      snapshotId,
      options || {}
    );

    return result;
  }

  /**
   * Build a snapshot inside a named tab.
   *
   * The bundle is only sent when the page turns out not to have it. It is a
   * large piece of source and most pages are snapshotted more than once, so
   * asking first costs one small round trip and saves sending it every time.
   */
  private async callInjectedScriptInTab(
    tabId: string,
    snapshotId: number,
    options?: SnapshotOptions
  ): Promise<InjectedScriptResult> {
    const optionsJson = JSON.stringify(options ?? {});

    const call = async (): Promise<string | null> => {
      const res = await this.sendBiDi!('script.callFunction', {
        functionDeclaration: CALL_SNAPSHOT,
        target: { context: tabId },
        awaitPromise: false,
        arguments: [
          { type: 'number', value: snapshotId },
          { type: 'string', value: optionsJson },
        ],
        serializationOptions: { maxDomDepth: 0 },
      });

      if (res?.type === 'exception') {
        throw new Error(
          `Snapshot failed in page: ${res.exceptionDetails?.text ?? 'unknown error'}`
        );
      }
      const value = res?.result?.value;
      return typeof value === 'string' ? value : null;
    };

    let payload = await call();

    if (payload === null) {
      const scriptSource = this.getInjectedScript();
      const inject = `() => {
        ${scriptSource}
        if (typeof __SnapshotInjected !== 'undefined' && __SnapshotInjected.createSnapshot) {
          window.__createSnapshot = __SnapshotInjected.createSnapshot;
        }
        return typeof window.__createSnapshot === 'function';
      }`;

      const injected = await this.sendBiDi!('script.callFunction', {
        functionDeclaration: inject,
        target: { context: tabId },
        awaitPromise: false,
        serializationOptions: { maxDomDepth: 0 },
      });

      if (injected?.type === 'exception') {
        throw new Error(
          `Could not prepare the page for snapshots: ${injected.exceptionDetails?.text ?? 'unknown error'}`
        );
      }

      payload = await call();
    }

    if (payload === null) {
      throw new Error('Snapshot builder did not load in the page');
    }

    return JSON.parse(payload) as InjectedScriptResult;
  }
}