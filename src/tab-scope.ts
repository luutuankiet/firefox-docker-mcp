/**
 * Deciding which captured entries belong to the tab an agent is working in.
 *
 * The browser files console output and network traffic under the context that
 * produced it, which is a frame or a popup as often as it is a tab. One shared
 * browser serving several agents therefore needs a rule that is neither the
 * strict equality that hides a page's own iframes, nor the free-for-all that
 * hands one agent another agent's traffic.
 *
 * The rule: an entry belongs to a tab when it came from that tab, from anything
 * nested inside it, or from a window that tab opened. Everything else, and
 * anything the browser attributed to no context at all, is withheld and
 * counted, so a reply can say what it is not showing instead of quietly
 * shrinking.
 */

import type { ContextTree, TabRelation } from './firefox/context-tree.js';

export type ScopeMode = 'tab' | 'all';

/** Shared schema fragment so every scoped tool advertises the knob identically. */
export const SCOPE_SCHEMA_PROPERTY = {
  scope: {
    type: 'string',
    enum: ['tab', 'all'],
    description:
      'Whose entries to return. tab (default) is your own tab, its frames, and any window it opened. all is every tab in the shared browser, including other agents.',
  },
} as const;

export interface Scoped<T> {
  /** Entries the caller may see, each tagged with the tab that owns it. */
  kept: Array<T & { tabRoot: string | null; tabRelation: TabRelation | null }>;
  /** Withheld because the browser named no context for them. */
  unattributed: number;
  /** Withheld because they belong to a different tab. */
  otherTabs: number;
  /** False when no tab was requested, in which case nothing was withheld. */
  scoped: boolean;
}

/**
 * Tag every entry with its owning tab and drop the ones outside `tabId`.
 *
 * A null `tabId` means the caller asked for the whole browser: nothing is
 * withheld, but the tagging still happens so the reply can name the tab each
 * row came from. Without a context tree the check degrades to plain equality,
 * which is what the server did before the tree existed.
 */
export function scopeEntries<T extends { context?: string }>(
  entries: T[],
  tabId: string | null,
  tree: ContextTree | null
): Scoped<T> {
  const kept: Scoped<T>['kept'] = [];
  let unattributed = 0;
  let otherTabs = 0;

  for (const entry of entries) {
    const context = entry?.context;
    const root = tree ? tree.rootOf(context) : context ?? null;

    if (!tabId) {
      kept.push({ ...entry, tabRoot: root, tabRelation: null });
      continue;
    }

    if (!context) {
      // Withholding beats guessing: an entry nobody claimed is as likely to be
      // another agent's as it is to be this one's.
      unattributed++;
      continue;
    }

    const relation: TabRelation | null = tree
      ? tree.relationTo(context, tabId)
      : context === tabId
        ? 'self'
        : null;

    if (!relation) {
      otherTabs++;
      continue;
    }
    kept.push({ ...entry, tabRoot: root, tabRelation: relation });
  }

  return { kept, unattributed, otherTabs, scoped: tabId !== null };
}

/**
 * One line naming what the scope held back, or null when it held back nothing.
 * An agent that sees a short list needs to know whether the browser was quiet
 * or the filter was busy.
 */
export function hiddenNote(scoped: Scoped<unknown>): string | null {
  if (!scoped.scoped) {
    return null;
  }
  const parts: string[] = [];
  if (scoped.otherTabs > 0) {
    parts.push(`${scoped.otherTabs} from other tabs`);
  }
  if (scoped.unattributed > 0) {
    parts.push(`${scoped.unattributed} unattributed`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `hidden: ${parts.join(', ')} (scope:"all" to see them)`;
}
