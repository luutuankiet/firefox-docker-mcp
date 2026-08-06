/**
 * Multi-tenant soft isolation for one shared Firefox instance.
 *
 * Every agent in the fleet reaches this server through the same MCP proxy, so
 * the transport session id names the proxy rather than the caller. Identity
 * therefore lives at the tool layer: the server mints an id on first contact,
 * echoes it in an envelope on every response, and callers hand it back on
 * later calls.
 *
 * Enforcement is advisory on purpose. Someone driving the browser over VNC owns
 * tabs that no agent may capture, and an agent reaching into another agent's
 * tab gets a warning rather than a refusal. The model is a shared machine:
 * everyone can see every tab, and is trusted to stay in its own lane.
 */

import { randomBytes } from 'node:crypto';

/** Owner recorded for any tab that no agent created or claimed. */
export const HUMAN_OWNER = 'human';

export interface TabView {
  tabId: string;
  index: number;
  title: string;
  url: string;
  owner: string;
}

export interface AgentRecord {
  id: string;
  label: string | null;
  cursorTabId: string | null;
  firstSeen: number;
  lastSeen: number;
}

export interface AgentResolution {
  agent: AgentRecord;
  minted: boolean;
  warning: string | null;
}

export interface TabResolution {
  tabId: string | null;
  view: TabView | null;
  warning: string | null;
  /** True when the server picked the tab instead of the caller naming it. */
  implicit: boolean;
}

function mintAgentId(): string {
  return `agt_${randomBytes(3).toString('hex')}`;
}

/**
 * Window handles are opaque and long. Envelopes show a prefix so a person can
 * match a response to a tab at a glance; the full id stays the wire value.
 */
export function shortTabId(tabId: string): string {
  const compact = tabId.replace(/[^a-zA-Z0-9]/g, '');
  return compact.length > 8 ? compact.slice(0, 8) : compact;
}

class TenancyRegistry {
  private agents = new Map<string, AgentRecord>();
  private claims = new Map<string, { owner: string; claimedAt: number }>();

  /**
   * Map an incoming `agent` argument to a record, minting one when the caller
   * has none. An id the server no longer knows - the usual cause is a restart
   * during development - is replaced rather than rejected, because failing a
   * browser action over bookkeeping helps nobody.
   */
  resolveAgent(rawId: unknown, rawLabel: unknown): AgentResolution {
    const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : null;
    const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : null;

    if (id) {
      const known = this.agents.get(id);
      if (known) {
        known.lastSeen = Date.now();
        if (label) {
          known.label = label;
        }
        return { agent: known, minted: false, warning: null };
      }
      const replacement = this.createAgent(label);
      return {
        agent: replacement,
        minted: true,
        warning: `agent "${id}" is unknown to this server (it likely restarted); reissued as ${replacement.id}`,
      };
    }

    const fresh = this.createAgent(label);
    return { agent: fresh, minted: true, warning: null };
  }

  private createAgent(label: string | null): AgentRecord {
    const now = Date.now();
    let id = mintAgentId();
    while (this.agents.has(id)) {
      id = mintAgentId();
    }
    const record: AgentRecord = {
      id,
      label,
      cursorTabId: null,
      firstSeen: now,
      lastSeen: now,
    };
    this.agents.set(id, record);
    return record;
  }

  getAgent(id: string): AgentRecord | null {
    return this.agents.get(id) ?? null;
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()];
  }

  /** Bind a tab to an agent. Used when an agent opens a tab, and by claim_tab. */
  claimTab(tabId: string, owner: string): void {
    this.claims.set(tabId, { owner, claimedAt: Date.now() });
  }

  /** Drop a claim, returning the tab to the unowned pool. */
  releaseTab(tabId: string): boolean {
    return this.claims.delete(tabId);
  }

  ownerOf(tabId: string): string {
    return this.claims.get(tabId)?.owner ?? HUMAN_OWNER;
  }

  tabsOwnedBy(agentId: string): string[] {
    const owned: string[] = [];
    for (const [tabId, claim] of this.claims) {
      if (claim.owner === agentId) {
        owned.push(tabId);
      }
    }
    return owned;
  }

  setCursor(agentId: string, tabId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.cursorTabId = tabId;
    }
  }

  /**
   * Forget claims and cursors for tabs that no longer exist, so a closed tab's
   * handle cannot be resurrected by a stale reference.
   */
  pruneClosedTabs(liveTabIds: string[]): void {
    const live = new Set(liveTabIds);
    for (const tabId of [...this.claims.keys()]) {
      if (!live.has(tabId)) {
        this.claims.delete(tabId);
      }
    }
    for (const agent of this.agents.values()) {
      if (agent.cursorTabId && !live.has(agent.cursorTabId)) {
        agent.cursorTabId = null;
      }
    }
  }

  /** Attach ownership to a raw tab list so callers always see who holds what. */
  decorateTabs(tabs: Array<{ actor: string; title: string; url: string }>): TabView[] {
    return tabs.map((tab, index) => ({
      tabId: tab.actor,
      index,
      title: tab.title || 'Untitled',
      url: tab.url || 'about:blank',
      owner: this.ownerOf(tab.actor),
    }));
  }

  /**
   * Decide which tab a call should act on.
   *
   * The order matters more than any single rule: an explicit argument wins,
   * then the agent's own last tab, then its sole tab if it has exactly one.
   * Only when an agent has no tab at all does the browser's focused tab get
   * used - and that case warns, because the focused tab is usually the one a
   * person is looking at over VNC.
   */
  resolveTab(agentId: string, rawTab: unknown, tabs: TabView[], selectedIdx: number): TabResolution {
    if (tabs.length === 0) {
      return { tabId: null, view: null, warning: null, implicit: true };
    }

    const requested = typeof rawTab === 'string' && rawTab.trim() ? rawTab.trim() : null;
    if (requested) {
      const exact = tabs.find((t) => t.tabId === requested);
      if (exact) {
        return {
          tabId: exact.tabId,
          view: exact,
          warning: this.crossOwnerWarning(agentId, exact),
          implicit: false,
        };
      }
      const byShortId = tabs.find((t) => shortTabId(t.tabId) === requested);
      if (byShortId) {
        return {
          tabId: byShortId.tabId,
          view: byShortId,
          warning: this.crossOwnerWarning(agentId, byShortId),
          implicit: false,
        };
      }
      const asIndex = Number(requested);
      if (Number.isInteger(asIndex) && tabs[asIndex]) {
        const view = tabs[asIndex]!;
        return {
          tabId: view.tabId,
          view,
          warning: [
            `tab "${requested}" read as index ${asIndex}; indices shift when any agent opens or closes a tab, so prefer tabId ${shortTabId(view.tabId)}`,
            this.crossOwnerWarning(agentId, view),
          ]
            .filter(Boolean)
            .join('; '),
          implicit: false,
        };
      }
      const known = tabs.map((t) => shortTabId(t.tabId)).join(', ');
      return {
        tabId: null,
        view: null,
        warning: `tab "${requested}" no longer exists (it may have been closed); open tabs: ${known}`,
        implicit: false,
      };
    }

    const agent = this.agents.get(agentId);
    if (agent?.cursorTabId) {
      const view = tabs.find((t) => t.tabId === agent.cursorTabId);
      if (view) {
        return { tabId: view.tabId, view, warning: null, implicit: true };
      }
    }

    const owned = this.tabsOwnedBy(agentId).filter((id) => tabs.some((t) => t.tabId === id));
    if (owned.length === 1) {
      const view = tabs.find((t) => t.tabId === owned[0])!;
      return { tabId: view.tabId, view, warning: null, implicit: true };
    }

    const focused = tabs[selectedIdx] ?? tabs[0]!;
    const belongsTo =
      focused.owner === HUMAN_OWNER
        ? 'is unowned and may be one a person is using'
        : `belongs to ${focused.owner}`;
    return {
      tabId: focused.tabId,
      view: focused,
      warning:
        owned.length > 1
          ? `no tab given and you hold ${owned.length}; fell back to the focused tab ${shortTabId(focused.tabId)} - pass tab explicitly to stay off tabs you do not own`
          : `no tab given and you hold none; fell back to the focused tab ${shortTabId(focused.tabId)}, which ${belongsTo} - call new_page to get a tab of your own`,
      implicit: true,
    };
  }

  private crossOwnerWarning(agentId: string, view: TabView): string | null {
    if (view.owner === agentId) {
      return null;
    }
    if (view.owner === HUMAN_OWNER) {
      return `tab ${shortTabId(view.tabId)} is unowned and may belong to a person at the VNC session`;
    }
    return `tab ${shortTabId(view.tabId)} belongs to ${view.owner}`;
  }
}

export const tenancy = new TenancyRegistry();

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One header line appended to every tool response. It is unconditional so an
 * agent never has to ask where it is: identity, the tab just acted on, and the
 * global tab census travel with the result of whatever it called.
 */
export function formatEnvelope(input: {
  agent: AgentRecord;
  minted: boolean;
  tab: TabView | null;
  tabs: TabView[];
  warnings: string[];
}): string {
  const { agent, minted, tab, tabs, warnings } = input;
  const lines: string[] = [];

  const mine = tabs.filter((t) => t.owner === agent.id).length;
  const human = tabs.filter((t) => t.owner === HUMAN_OWNER).length;
  const others = tabs.length - mine - human;

  const census: string[] = [];
  if (mine) census.push(`${mine} yours`);
  if (others) census.push(`${others} other agents`);
  if (human) census.push(`${human} unowned`);

  const where = tab
    ? `tab ${shortTabId(tab.tabId)} "${truncate(tab.title, 40)}"`
    : 'no tab';

  lines.push(
    `── ${agent.id} · ${where} · ${tabs.length} tabs${
      census.length ? ` (${census.join(', ')})` : ''
    }`
  );

  if (tab) {
    lines.push(`   ${truncate(tab.url, 100)}`);
  }

  if (minted) {
    lines.push(
      `   new identity: pass agent:"${agent.id}" on every later call so your tabs stay yours`
    );
  }

  for (const warning of warnings) {
    lines.push(`   ! ${warning}`);
  }

  return lines.join('\n');
}
