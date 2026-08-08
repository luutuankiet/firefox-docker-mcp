/**
 * Multi-tenant soft isolation for one shared Firefox instance.
 *
 * Every agent in the fleet reaches this server through the same MCP proxy, so
 * the transport session id names the proxy rather than the caller. Identity
 * therefore lives at the tool layer: the server mints an id on first contact,
 * echoes it in an envelope on every response, and callers hand it back on
 * later calls.
 *
 * Reads stay open across the whole browser - any agent may list, screenshot or
 * snapshot any tab, which is what makes a shared machine debuggable. Writes are
 * the opposite: a tab the caller neither named nor owns is refused outright.
 * A warning was tried first and lost to task momentum - one agent read an
 * accurate warning six times running and kept clicking - so the write boundary
 * is mechanical now rather than advisory.
 */

import { randomBytes } from 'node:crypto';

/** Owner recorded for any tab that no agent created or claimed. */
export const HUMAN_OWNER = 'human';

export interface TabView {
  tabId: string;
  /** Word this tab answers to, e.g. `maple`. Stable while the tab lives. */
  name: string;
  index: number;
  title: string;
  url: string;
  owner: string;
}

/** A viewport an agent asked for, held so later callers can see it. */
export interface TabViewport {
  width: number;
  height: number;
  devicePixelRatio?: number;
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

/**
 * How a tab came to be the target of a call. The dispatcher gates writes on
 * this: everything except `fallback` reflects either an explicit request or a
 * tab the caller already holds, whereas `fallback` means the server guessed
 * from whatever happened to be on screen - which is somebody else's business.
 */
export type TabResolutionSource =
  /** Caller named the tab by id, short id or index. */
  | 'explicit'
  /** Caller's own cursor from a previous call. */
  | 'cursor'
  /** Caller owns exactly one tab, so there was nothing to disambiguate. */
  | 'sole'
  /** Nothing pointed at a tab; the globally focused one was assumed. */
  | 'fallback'
  /** No tab could be resolved at all. */
  | 'none';

export interface TabResolution {
  tabId: string | null;
  view: TabView | null;
  warning: string | null;
  /** True when the server picked the tab instead of the caller naming it. */
  implicit: boolean;
  source: TabResolutionSource;
}

/** The last write a tab received, kept so the next caller can be told. */
export interface TabAction {
  agentId: string;
  tool: string;
  at: number;
}

/**
 * Colour reserved for tabs no agent holds. A person opening tabs at the VNC
 * session should see them stay neutral, so grey never means "some agent".
 */
export const UNOWNED_COLOR = '#9e9e9e';

/**
 * Distinct hues for agent tabs. Picked for separation at favicon size, where a
 * 16px square is all the signal there is.
 */
const AGENT_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#00b8b8',
  '#f032e6',
  '#9a6324',
];

/**
 * Stable colour for an agent. Derived from the id rather than assigned in
 * order, so a tab keeps its colour across a server restart that renumbers
 * everything else.
 */
export function agentColor(agentId: string): string {
  if (!agentId || agentId === HUMAN_OWNER) {
    return UNOWNED_COLOR;
  }
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return AGENT_COLORS[hash % AGENT_COLORS.length]!;
}

function mintAgentId(): string {
  return `agt_${randomBytes(3).toString('hex')}`;
}

/**
 * Words handed out as tab names. Chosen to be pronounceable, concrete and
 * unlike each other when skimmed - a person glancing at a VNC session should
 * be able to hold "maple" in their head where "a5126214" slid straight out of
 * it. Kept clear of anything that reads as a status word, so a name is never
 * mistaken for a message.
 */
const TAB_WORDS = [
  'amber', 'anchor', 'apple', 'arbor', 'arrow', 'aspen', 'atlas', 'autumn',
  'bacon', 'badge', 'bagel', 'balloon', 'bamboo', 'banjo', 'barley', 'basil',
  'beacon', 'beetle', 'birch', 'bishop', 'bison', 'blossom', 'bonsai', 'boulder',
  'bramble', 'bronze', 'bubble', 'bucket', 'buffalo', 'bugle', 'bunker', 'butter',
  'cabin', 'cactus', 'camel', 'candle', 'canyon', 'carbon', 'cargo', 'carrot',
  'cedar', 'cello', 'chalk', 'cherry', 'chimney', 'cinder', 'citrus', 'clover',
  'cobalt', 'cocoa', 'comet', 'copper', 'coral', 'cotton', 'cougar', 'crater',
  'crimson', 'crystal', 'cypress', 'dahlia', 'daisy', 'dapple', 'delta', 'denim',
  'diamond', 'dingo', 'domino', 'donkey', 'dragon', 'dune', 'dusk', 'eagle',
  'ember', 'emerald', 'falcon', 'fennel', 'fern', 'fiddle', 'flint', 'forest',
  'fossil', 'fountain', 'foxglove', 'frost', 'galaxy', 'garnet', 'gecko', 'ginger',
  'glacier', 'granite', 'gravel', 'grotto', 'guava', 'gully', 'gypsum', 'hammock',
  'harbor', 'harvest', 'hazel', 'heather', 'hickory', 'hollow', 'honey', 'hornet',
  'ivory', 'jasmine', 'jetty', 'jigsaw', 'juniper', 'kayak', 'kelp', 'kettle',
  'koala', 'lagoon', 'lantern', 'lark', 'lattice', 'lavender', 'ledger', 'lemon',
  'lichen', 'lilac', 'linen', 'lobster', 'locket', 'lotus', 'lumber', 'magnet',
  'mango', 'maple', 'marble', 'marlin', 'meadow', 'mesa', 'meteor', 'mint',
  'mirror', 'mitten', 'monsoon', 'moss', 'mulberry', 'nectar', 'nickel', 'nutmeg',
  'oasis', 'obsidian', 'olive', 'onyx', 'opal', 'orbit', 'orchid', 'osprey',
  'otter', 'oxide', 'paddle', 'pagoda', 'pantry', 'papaya', 'parsley', 'pebble',
  'pelican', 'pepper', 'petal', 'pewter', 'pigeon', 'pine', 'plum', 'pollen',
  'pumice', 'quartz', 'quiver', 'radish', 'rattan', 'raven', 'ribbon', 'rosemary',
  'saffron', 'sage', 'sandal', 'sapphire', 'satin', 'scarlet', 'sequoia', 'shale',
  'sienna', 'silver', 'sorrel', 'spruce', 'sugar', 'sumac', 'tamarind', 'teak',
  'thistle', 'thyme', 'timber', 'topaz', 'truffle', 'tulip', 'tundra', 'turmeric',
  'umber', 'velvet', 'verbena', 'vessel', 'violet', 'walnut', 'willow', 'zephyr',
];

/**
 * The first eight characters of a window handle. No longer shown anywhere, but
 * still accepted as a selector so ids copied out of an older transcript keep
 * working.
 */
export function tabIdPrefix(tabId: string): string {
  const compact = tabId.replace(/[^a-zA-Z0-9]/g, '');
  return compact.length > 8 ? compact.slice(0, 8) : compact;
}

/**
 * The name a tab answers to. Window handles are opaque hex that a person
 * cannot hold in their head or say out loud, which matters because the same
 * tab has to be recognised in a tool response, in a VNC window and in a
 * sentence typed to another agent. One word does all three.
 */
export function tabName(tabId: string): string {
  return tenancy.nameFor(tabId);
}

class TenancyRegistry {
  private agents = new Map<string, AgentRecord>();
  private claims = new Map<string, { owner: string; claimedAt: number }>();
  /** tabId -> word. Minted on first sight, kept until the tab closes. */
  private names = new Map<string, string>();
  /** Words currently spoken for, so two live tabs never share one. */
  private takenNames = new Set<string>();
  /**
   * Viewport overrides, tracked because a tab silently rendering at phone
   * width is the kind of thing the next caller needs told rather than left to
   * deduce from a screenshot that looks wrong.
   */
  private viewports = new Map<string, TabViewport>();
  /**
   * Last write per tab, tracked separately from claims because an unowned tab
   * still gets navigated - and the caller who finds it changed deserves to
   * know by whom without opening an investigation.
   */
  private actions = new Map<string, TabAction>();

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

  /**
   * The word this tab answers to, minting one the first time it is asked for.
   *
   * The starting point is derived from the handle, so a tab tends to keep its
   * name across a server restart; the walk forward from there is what
   * guarantees no two live tabs collide, which matters because the name is a
   * selector and not just a label.
   */
  nameFor(tabId: string): string {
    if (!tabId) {
      return '';
    }
    const existing = this.names.get(tabId);
    if (existing) {
      return existing;
    }
    let hash = 0;
    for (let i = 0; i < tabId.length; i += 1) {
      hash = (hash * 31 + tabId.charCodeAt(i)) >>> 0;
    }
    const start = hash % TAB_WORDS.length;
    let name = '';
    for (let i = 0; i < TAB_WORDS.length; i += 1) {
      const candidate = TAB_WORDS[(start + i) % TAB_WORDS.length]!;
      if (!this.takenNames.has(candidate)) {
        name = candidate;
        break;
      }
    }
    // More live tabs than words is not a case worth designing for, but it is a
    // case worth surviving.
    if (!name) {
      name = `${TAB_WORDS[start]}-${this.names.size + 1}`;
    }
    this.names.set(tabId, name);
    this.takenNames.add(name);
    return name;
  }

  /** Look a tab up by the word it answers to. Case does not matter. */
  tabIdForName(name: string): string | null {
    const wanted = name.trim().toLowerCase();
    for (const [tabId, word] of this.names) {
      if (word === wanted) {
        return tabId;
      }
    }
    return null;
  }

  /** Record a viewport override so it can be reported, or clear it with null. */
  setViewport(tabId: string, viewport: TabViewport | null): void {
    if (viewport) {
      this.viewports.set(tabId, viewport);
    } else {
      this.viewports.delete(tabId);
    }
  }

  viewportOf(tabId: string | null | undefined): TabViewport | null {
    return tabId ? (this.viewports.get(tabId) ?? null) : null;
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

  /** Note who last changed a tab, so the next caller is not left guessing. */
  recordAction(tabId: string, agentId: string, tool: string): void {
    this.actions.set(tabId, { agentId, tool, at: Date.now() });
  }

  lastActionOn(tabId: string | null | undefined): TabAction | null {
    return tabId ? (this.actions.get(tabId) ?? null) : null;
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
    for (const tabId of [...this.actions.keys()]) {
      if (!live.has(tabId)) {
        this.actions.delete(tabId);
      }
    }
    for (const tabId of [...this.viewports.keys()]) {
      if (!live.has(tabId)) {
        this.viewports.delete(tabId);
      }
    }
    // A closed tab's word goes back in the pool, so a long-lived server does
    // not slowly run out of names it is no longer using.
    for (const [tabId, word] of [...this.names]) {
      if (!live.has(tabId)) {
        this.names.delete(tabId);
        this.takenNames.delete(word);
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
      name: this.nameFor(tab.actor),
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
      return { tabId: null, view: null, warning: null, implicit: true, source: 'none' };
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
          source: 'explicit',
        };
      }
      const lowered = requested.toLowerCase();
      const byName = tabs.find((t) => t.name === lowered);
      if (byName) {
        return {
          tabId: byName.tabId,
          view: byName,
          warning: this.crossOwnerWarning(agentId, byName),
          implicit: false,
          source: 'explicit',
        };
      }
      // Hex prefixes are no longer printed anywhere, but a caller replaying an
      // older transcript should not be told its tab vanished.
      const byPrefix = tabs.find((t) => tabIdPrefix(t.tabId) === requested);
      if (byPrefix) {
        return {
          tabId: byPrefix.tabId,
          view: byPrefix,
          warning: this.crossOwnerWarning(agentId, byPrefix),
          implicit: false,
          source: 'explicit',
        };
      }
      const asIndex = Number(requested);
      if (Number.isInteger(asIndex) && tabs[asIndex]) {
        const view = tabs[asIndex]!;
        return {
          tabId: view.tabId,
          view,
          warning: [
            `tab "${requested}" read as index ${asIndex}; indices shift when any agent opens or closes a tab, so prefer tabId ${tabName(view.tabId)}`,
            this.crossOwnerWarning(agentId, view),
          ]
            .filter(Boolean)
            .join('; '),
          implicit: false,
          source: 'explicit',
        };
      }
      const known = tabs.map((t) => tabName(t.tabId)).join(', ');
      return {
        tabId: null,
        view: null,
        warning: `tab "${requested}" no longer exists (it may have been closed); open tabs: ${known}`,
        implicit: false,
        source: 'none',
      };
    }

    const agent = this.agents.get(agentId);
    if (agent?.cursorTabId) {
      const view = tabs.find((t) => t.tabId === agent.cursorTabId);
      if (view) {
        return { tabId: view.tabId, view, warning: null, implicit: true, source: 'cursor' };
      }
    }

    const owned = this.tabsOwnedBy(agentId).filter((id) => tabs.some((t) => t.tabId === id));
    if (owned.length === 1) {
      const view = tabs.find((t) => t.tabId === owned[0])!;
      return { tabId: view.tabId, view, warning: null, implicit: true, source: 'sole' };
    }

    // Last resort, and only ever good enough to read from. The dispatcher
    // refuses writes that land here, because "whatever is on screen" is a
    // property of the browser rather than of the request - two calls a second
    // apart can resolve to different tabs, which is exactly how one agent ends
    // up driving another's page.
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
          ? `no tab given and you hold ${owned.length}; reading the focused tab ${tabName(focused.tabId)} - pass tab explicitly, writes will not use this fallback`
          : `no tab given and you hold none; reading the focused tab ${tabName(focused.tabId)}, which ${belongsTo} - call new_page to get a tab of your own`,
      implicit: true,
      source: 'fallback',
    };
  }

  private crossOwnerWarning(agentId: string, view: TabView): string | null {
    if (view.owner === agentId) {
      return null;
    }
    if (view.owner === HUMAN_OWNER) {
      return `tab ${tabName(view.tabId)} is unowned and may belong to a person at the VNC session`;
    }
    return `tab ${tabName(view.tabId)} belongs to ${view.owner}`;
  }
}

export const tenancy = new TenancyRegistry();

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Rough age in the largest unit that still reads as a number, for breadcrumbs. */
function describeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
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
  /** Last write this tab received, when it came from somebody else. */
  lastWriter?: TabAction | null;
}): string {
  const { agent, minted, tab, tabs, warnings, lastWriter } = input;
  const lines: string[] = [];

  const mine = tabs.filter((t) => t.owner === agent.id).length;
  const human = tabs.filter((t) => t.owner === HUMAN_OWNER).length;
  const others = tabs.length - mine - human;

  const census: string[] = [];
  if (mine) census.push(`${mine} yours`);
  if (others) census.push(`${others} other agents`);
  if (human) census.push(`${human} unowned`);

  const viewport = tab ? tenancy.viewportOf(tab.tabId) : null;
  const geometry = viewport
    ? ` ${viewport.width}x${viewport.height}${
        viewport.devicePixelRatio && viewport.devicePixelRatio !== 1
          ? `@${viewport.devicePixelRatio}x`
          : ''
      }`
    : '';

  const where = tab
    ? `tab ${tabName(tab.tabId)}${geometry} "${truncate(tab.title, 40)}"`
    : 'no tab';

  lines.push(
    `── ${agent.id} · ${where} · ${tabs.length} tabs${
      census.length ? ` (${census.join(', ')})` : ''
    }`
  );

  if (tab) {
    lines.push(`   ${truncate(tab.url, 100)}`);
  }

  // A tab that changed under the caller is the single hardest thing to work
  // out from the inside: the page simply is not what it was, with no evidence
  // of why. Naming the agent and the tool turns a mystery into a fact.
  if (tab && lastWriter && lastWriter.agentId !== agent.id) {
    lines.push(
      `   ! ${lastWriter.agentId} ran ${lastWriter.tool} on this tab ${describeAge(
        Date.now() - lastWriter.at
      )} ago - the page may not be the one you left`
    );
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
