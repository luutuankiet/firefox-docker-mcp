/**
 * Browsing-context topology: which tab a console message or network request
 * actually came from.
 *
 * Every captured entry carries the id of the context that produced it. That
 * context is often not a tab: an iframe is a child context, and a window.open()
 * popup is a *sibling* top-level context whose only link to its opener is the
 * opener field. Comparing the entry's context to a tab id therefore drops both,
 * which is why a page's own iframe traffic used to go missing from its reply.
 *
 * This module keeps the parent and opener links needed to resolve an arbitrary
 * context back to the tab that owns it. Nodes outlive their contexts by the
 * same TTL the log buffers use, so an entry from a frame that has since been
 * torn down still resolves instead of falling out as unattributable.
 */

import type { WebDriver } from 'selenium-webdriver';
import { logDebug } from '../utils/logger.js';

/** Matched to the console and network buffer TTLs so a live entry always has a node. */
const NODE_TTL_MS = 5 * 60 * 1000;
/** Pruning walks the whole map, and the map changes far slower than entries arrive. */
const PRUNE_INTERVAL_MS = 30 * 1000;
/** Guards the parent and opener walks against a cycle a buggy payload could introduce. */
const MAX_WALK_DEPTH = 64;

/** How an entry's context relates to the tab an agent asked about. */
export type TabRelation = 'self' | 'popup';

export interface ContextNode {
  context: string;
  /** The containing context for an iframe; null for anything top-level. */
  parent: string | null;
  /**
   * The context that called window.open(). Present on popups, absent on tabs
   * opened through the automation API, which is what keeps agent-created tabs
   * from being mistaken for popups belonging to whoever created them.
   */
  originalOpener: string | null;
  /** The OS window this context is painted in; distinguishes a popup window from a popup tab. */
  clientWindow: string | null;
  url: string;
  /** Set when the browser tears the context down; the node survives for TTL after that. */
  destroyedAt: number | null;
}

export class ContextTree {
  private nodes = new Map<string, ContextNode>();
  private subscribed = false;
  private lastPrune = 0;

  constructor(
    private driver: WebDriver,
    private sendBiDi: (method: string, params?: Record<string, any>) => Promise<any>
  ) {}

  /**
   * Start tracking, then backfill whatever the browser already had open.
   *
   * The backfill is not optional: subscriptions only report contexts created
   * from now on, and the tabs an agent is about to ask about generally predate
   * the connection.
   */
  async subscribe(): Promise<void> {
    if (this.subscribed) {
      return;
    }

    const bidi = await (this.driver as any).getBidi();
    await bidi.subscribe('browsingContext.contextCreated', undefined);
    try {
      await bidi.subscribe('browsingContext.contextDestroyed', undefined);
    } catch {
      // Losing the teardown signal only costs pruning accuracy: nodes then live
      // until the browser reuses the id or the process ends, and resolution of
      // live entries is unaffected.
      logDebug('Context destruction events unavailable; tree will keep stale nodes');
    }

    const ws: any = bidi.socket;
    ws.on('message', (data: any) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload?.method === 'browsingContext.contextCreated') {
          this.record(payload.params, null);
        } else if (payload?.method === 'browsingContext.contextDestroyed') {
          this.markDestroyed(payload.params?.context);
        }
      } catch {
        // ignore parse errors
      }
    });

    this.subscribed = true;
    await this.refresh();
    logDebug(`Context tree active (${this.nodes.size} contexts known)`);
  }

  /**
   * Re-read the whole tree from the browser.
   *
   * Callers use this as a repair step when a context turns up that the event
   * stream never announced, which happens if a subscription was established
   * late or dropped.
   */
  async refresh(): Promise<void> {
    let tree: any;
    try {
      tree = await this.sendBiDi('browsingContext.getTree', {});
    } catch {
      return;
    }

    const roots: any[] = Array.isArray(tree?.contexts) ? tree.contexts : [];
    const walk = (infos: any[], parent: string | null): void => {
      for (const info of infos) {
        if (!info || typeof info.context !== 'string') {
          continue;
        }
        this.record(info, parent);
        if (Array.isArray(info.children)) {
          walk(info.children, info.context);
        }
      }
    };
    walk(roots, null);
  }

  /**
   * The top-level context an arbitrary context belongs to - its tab.
   *
   * A context nobody has told us about is treated as its own root rather than
   * as unresolvable, so an unknown id still matches a tab of the same id. That
   * is exactly the equality check this module replaces, which makes the
   * degraded case no worse than having no tree at all.
   */
  rootOf(contextId: string | null | undefined): string | null {
    if (!contextId) {
      return null;
    }
    this.maybePrune();

    let current = contextId;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      const node = this.nodes.get(current);
      if (!node || !node.parent) {
        return current;
      }
      current = node.parent;
    }
    return current;
  }

  /**
   * Whether an entry from `contextId` should be reported to an agent working in
   * `tabId`, and under what label.
   *
   * 'self' covers the tab and everything nested inside it. 'popup' covers a
   * window the tab opened, directly or through a chain of further popups - the
   * traffic is the tab's doing even though the browser files it elsewhere.
   */
  relationTo(contextId: string | null | undefined, tabId: string): TabRelation | null {
    const root = this.rootOf(contextId);
    if (!root) {
      return null;
    }
    if (root === tabId) {
      return 'self';
    }

    let current: string | null = root;
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_WALK_DEPTH && current; depth++) {
      if (seen.has(current)) {
        return null;
      }
      seen.add(current);

      const node = this.nodes.get(current);
      if (!node?.originalOpener) {
        return null;
      }
      const openerRoot = this.rootOf(node.originalOpener);
      if (!openerRoot || openerRoot === current) {
        return null;
      }
      if (openerRoot === tabId) {
        return 'popup';
      }
      current = openerRoot;
    }
    return null;
  }

  /**
   * A top-level context that some page opened, as opposed to one the agent or
   * the human opened directly. Tabs created through the automation API carry no
   * opener, so they are never reported as popups.
   */
  isPopup(contextId: string | null | undefined): boolean {
    if (!contextId) {
      return false;
    }
    const node = this.nodes.get(contextId);
    return !!node && !node.parent && !!node.originalOpener;
  }

  /** The recorded topology for one context, for callers that need the raw links. */
  nodeOf(contextId: string | null | undefined): ContextNode | null {
    if (!contextId) {
      return null;
    }
    return this.nodes.get(contextId) ?? null;
  }

  /** Every top-level context currently believed to be alive. */
  roots(): ContextNode[] {
    return [...this.nodes.values()].filter((node) => !node.parent && node.destroyedAt === null);
  }

  /** True once the browser has told us about this context. */
  knows(contextId: string | null | undefined): boolean {
    return !!contextId && this.nodes.has(contextId);
  }

  private record(info: any, fallbackParent: string | null): void {
    if (!info || typeof info.context !== 'string') {
      return;
    }
    // Event payloads and tree nodes are built by the same browser code, but a
    // re-announced context can arrive with fewer fields populated than the one
    // already on file, so known links are kept rather than overwritten with null.
    const existing = this.nodes.get(info.context);
    const parent =
      typeof info.parent === 'string' ? info.parent : fallbackParent ?? existing?.parent ?? null;

    this.nodes.set(info.context, {
      context: info.context,
      parent,
      originalOpener:
        typeof info.originalOpener === 'string'
          ? info.originalOpener
          : existing?.originalOpener ?? null,
      clientWindow:
        typeof info.clientWindow === 'string' ? info.clientWindow : existing?.clientWindow ?? null,
      url: typeof info.url === 'string' && info.url ? info.url : existing?.url ?? '',
      destroyedAt: null,
    });
  }

  private markDestroyed(contextId: unknown): void {
    if (typeof contextId !== 'string') {
      return;
    }
    const node = this.nodes.get(contextId);
    if (node) {
      node.destroyedAt = Date.now();
    }
  }

  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPrune = now;

    const cutoff = now - NODE_TTL_MS;
    for (const [id, node] of this.nodes) {
      if (node.destroyedAt !== null && node.destroyedAt < cutoff) {
        this.nodes.delete(id);
      }
    }
  }
}
