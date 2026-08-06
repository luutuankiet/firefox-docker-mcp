/**
 * Tools for managing who owns which tab.
 *
 * Ownership is otherwise implicit: a tab belongs to whoever opened it. These
 * exist for the cases implicit binding cannot cover - handing a tab to another
 * agent, or adopting one that a person opened and then asked for help with.
 */

import { successResponse, errorResponse } from '../utils/response-helpers.js';
import { tenancy, shortTabId, HUMAN_OWNER } from '../tenancy.js';
import type { McpToolResponse } from '../types/common.js';

export const claimTabTool = {
  name: 'claim_tab',
  description:
    'Take ownership of a tab so later calls of yours default to it. Pass tab to name one, or omit to claim the tab you are already acting on.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export const releaseTabTool = {
  name: 'release_tab',
  description:
    'Give up ownership of a tab, returning it to the unowned pool so another agent or a person can take it over.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export const listAgentsTool = {
  name: 'list_agents',
  description:
    'List every agent this browser has seen, with how many tabs each holds. Use it to work out who else is sharing the session.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export async function handleClaimTab(args: unknown): Promise<McpToolResponse> {
  try {
    const { agent, tab, tabWasNamed } = (args ?? {}) as {
      agent?: string;
      tab?: string;
      tabWasNamed?: boolean;
    };

    if (!agent) {
      throw new Error('No agent identity resolved for this call');
    }
    if (!tab) {
      throw new Error('No tab to claim - open one with new_page, or pass tab explicitly');
    }

    const previous = tenancy.ownerOf(tab);

    // An unowned tab is most likely one a person is using at the VNC session.
    // Adopting it has to be deliberate, so a call that merely fell back to the
    // focused tab cannot take it by accident.
    if (previous === HUMAN_OWNER && !tabWasNamed) {
      throw new Error(
        `tab ${shortTabId(tab)} is unowned and was only the focused tab, not one you named. ` +
          'Someone may be using it. Pass its tab id explicitly to adopt it on purpose.'
      );
    }
    tenancy.claimTab(tab, agent);
    tenancy.setCursor(agent, tab);

    const from = previous === HUMAN_OWNER ? 'the unowned pool' : previous;
    return successResponse(`✅ tab ${shortTabId(tab)} claimed from ${from}`);
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleReleaseTab(args: unknown): Promise<McpToolResponse> {
  try {
    const { agent, tab } = (args ?? {}) as { agent?: string; tab?: string };

    if (!tab) {
      throw new Error('No tab to release - pass tab explicitly');
    }

    const owner = tenancy.ownerOf(tab);
    if (owner === HUMAN_OWNER) {
      return successResponse(`tab ${shortTabId(tab)} was already unowned`);
    }

    tenancy.releaseTab(tab);
    const note = owner === agent ? '' : ` (it belonged to ${owner})`;
    return successResponse(`✅ tab ${shortTabId(tab)} released${note}`);
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleListAgents(args: unknown): Promise<McpToolResponse> {
  try {
    const { agent } = (args ?? {}) as { agent?: string };
    const agents = tenancy.listAgents();

    if (agents.length === 0) {
      return successResponse('No agents seen yet');
    }

    const lines = [`👥 ${agents.length} agents`];
    for (const record of agents.sort((a, b) => b.lastSeen - a.lastSeen)) {
      const held = tenancy.tabsOwnedBy(record.id).length;
      const self = record.id === agent ? ' (you)' : '';
      const label = record.label ? ` "${record.label}"` : '';
      const idle = Math.round((Date.now() - record.lastSeen) / 1000);
      lines.push(`  ${record.id}${label}${self}  ${held} tabs  last seen ${idle}s ago`);
    }
    return successResponse(lines.join('\n'));
  } catch (error) {
    return errorResponse(error as Error);
  }
}
