/**
 * Console tools for MCP
 */

import {
  successResponse,
  errorResponse,
  jsonResponse,
  TOKEN_LIMITS,
  truncateText,
} from '../utils/response-helpers.js';
import type { McpToolResponse } from '../types/common.js';
import { scopeEntries, hiddenNote, SCOPE_SCHEMA_PROPERTY, type ScopeMode } from '../tab-scope.js';
import { tabName } from '../tenancy.js';

export const listConsoleMessagesTool = {
  name: 'list_console_messages',
  description:
    'List console messages from your tab, its frames, and windows it opened. Supports filtering by level, time, text, source.',
  inputSchema: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: ['debug', 'info', 'warn', 'error'],
        description: 'Filter by level',
      },
      limit: {
        type: 'number',
        description: 'Max messages (default: 50)',
      },
      sinceMs: {
        type: 'number',
        description: 'Only last N ms',
      },
      textContains: {
        type: 'string',
        description: 'Text filter (case-insensitive)',
      },
      source: {
        type: 'string',
        description: 'Filter by source',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format (default: text)',
      },
      ...SCOPE_SCHEMA_PROPERTY,
    },
  },
};

export const clearConsoleMessagesTool = {
  name: 'clear_console_messages',
  description:
    'Clear collected console messages for your tab. Use scope:"all" to clear the whole shared buffer, which affects every agent.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SCOPE_SCHEMA_PROPERTY,
    },
  },
};

// Level emoji mapping
const LEVEL_EMOJI: Record<string, string> = {
  debug: '🔍',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
};

const DEFAULT_LIMIT = 50;

export async function handleListConsoleMessages(args: unknown): Promise<McpToolResponse> {
  try {
    const {
      level,
      limit,
      sinceMs,
      textContains,
      source,
      format = 'text',
      tab,
      scope = 'tab',
    } = (args as {
      level?: string;
      limit?: number;
      sinceMs?: number;
      textContains?: string;
      source?: string;
      format?: 'text' | 'json';
      tab?: string;
      scope?: ScopeMode;
    }) || {};

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    const buffer = (await firefox.getConsoleMessages()) as any[];
    const totalCount = buffer.length;

    // The buffer is browser-wide and shared, so what an agent may see is decided
    // here rather than left to whatever the browser happened to log.
    const tree = typeof (firefox as any).getContextTree === 'function' ? (firefox as any).getContextTree() : null;
    const scoped = scopeEntries(buffer, scope === 'all' ? null : tab ?? null, tree);
    let messages = scoped.kept;
    const withheld = hiddenNote(scoped);

    // Apply filters
    if (level) {
      messages = messages.filter((msg) => msg.level.toLowerCase() === level.toLowerCase());
    }

    if (sinceMs !== undefined) {
      const cutoffTime = Date.now() - sinceMs;
      messages = messages.filter((msg) => msg.timestamp && msg.timestamp >= cutoffTime);
    }

    if (textContains) {
      const textLower = textContains.toLowerCase();
      messages = messages.filter((msg) => msg.text.toLowerCase().includes(textLower));
    }

    if (source) {
      messages = messages.filter((msg) => msg.source?.toLowerCase() === source.toLowerCase());
    }

    // Truncate individual message texts to prevent token overflow
    messages = messages.map((msg) => ({
      ...msg,
      text: truncateText(msg.text, TOKEN_LIMITS.MAX_CONSOLE_MESSAGE_CHARS, '...[truncated]'),
    }));

    // Apply limit
    const maxLimit = limit ?? DEFAULT_LIMIT;
    const filteredCount = messages.length;
    const truncated = messages.length > maxLimit;
    messages = messages.slice(0, maxLimit);

    if (messages.length === 0) {
      const filterInfo = [];
      if (level) {
        filterInfo.push(`level=${level}`);
      }
      if (sinceMs) {
        filterInfo.push(`sinceMs=${sinceMs}`);
      }
      if (textContains) {
        filterInfo.push(`textContains="${textContains}"`);
      }
      if (source) {
        filterInfo.push(`source="${source}"`);
      }

      if (format === 'json') {
        return jsonResponse({
          total: totalCount,
          filtered: 0,
          showing: 0,
          scope,
          hidden: withheld,
          filters: filterInfo.length > 0 ? filterInfo.join(', ') : null,
          messages: [],
        });
      }

      return successResponse(
        `No console messages found matching filters.\n` +
          `Total messages: ${totalCount}${filterInfo.length > 0 ? `, Filters: ${filterInfo.join(', ')}` : ''}` +
          (withheld ? `\n${withheld}` : '')
      );
    }

    // JSON format
    if (format === 'json') {
      const filterInfo = [];
      if (level) {
        filterInfo.push(`level=${level}`);
      }
      if (sinceMs) {
        filterInfo.push(`sinceMs=${sinceMs}`);
      }
      if (textContains) {
        filterInfo.push(`textContains="${textContains}"`);
      }
      if (source) {
        filterInfo.push(`source="${source}"`);
      }

      return jsonResponse({
        total: totalCount,
        filtered: filteredCount,
        showing: messages.length,
        hasMore: truncated,
        scope,
        hidden: withheld,
        filters: filterInfo.length > 0 ? filterInfo.join(', ') : null,
        messages: messages.map((msg) => ({
          level: msg.level,
          text: msg.text,
          source: msg.source || null,
          timestamp: msg.timestamp || null,
          tab: msg.tabRoot ? tabName(msg.tabRoot) : null,
          via: msg.tabRelation === 'popup' ? 'popup' : null,
        })),
      });
    }

    // Format messages as text
    let output = `Console messages (showing ${messages.length}`;
    if (filteredCount > messages.length) {
      output += ` of ${filteredCount} matching`;
    }
    output += `, ${totalCount} total):\n`;

    if (level || sinceMs || textContains || source) {
      output += `Filters:`;
      if (level) {
        output += ` level=${level}`;
      }
      if (sinceMs) {
        output += ` sinceMs=${sinceMs}`;
      }
      if (textContains) {
        output += ` textContains="${textContains}"`;
      }
      if (source) {
        output += ` source="${source}"`;
      }
      output += '\n';
    }
    output += '\n';

    let sawPopup = false;
    for (const msg of messages) {
      const emoji = LEVEL_EMOJI[msg.level.toLowerCase()] || '📝';
      const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';
      const source = msg.source ? ` [${msg.source}]` : '';
      const time = timestamp ? `[${timestamp}] ` : '';
      // Under tab scope every row is the caller's, so only the popup rows need
      // marking. Listing the whole browser is the case where a row is useless
      // without knowing whose tab it came from.
      let owner = '';
      if (msg.tabRelation === 'popup') {
        sawPopup = true;
        owner = '↗ ';
      } else if (scope === 'all' && msg.tabRoot) {
        owner = `[${tabName(msg.tabRoot)}] `;
      }

      output += `${emoji} ${owner}${time}${msg.level.toUpperCase()}${source}: ${msg.text}\n`;
    }

    if (sawPopup) {
      output += `\n↗ = a window your tab opened`;
    }

    if (truncated) {
      output += `\n[+${filteredCount - messages.length} more]`;
    }

    if (withheld) {
      output += `\n${withheld}`;
    }

    return successResponse(output);
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleClearConsoleMessages(args: unknown): Promise<McpToolResponse> {
  try {
    const { tab, scope = 'tab' } = (args as { tab?: string; scope?: ScopeMode }) || {};

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    // Clearing the whole buffer in a browser several agents are reading from
    // destroys evidence that is not the caller's to destroy, so it has to be
    // asked for rather than arrived at by leaving an argument off.
    if (scope === 'all') {
      const count = firefox.clearConsoleMessages();
      return successResponse(`✅ cleared ${count} messages (every tab in the shared browser)`);
    }

    if (!tab) {
      // Falling back to a full wipe here would let a caller who named no tab
      // destroy every other agent's evidence by accident.
      return successResponse(
        'No tab resolved, so nothing was cleared. Name a tab, or pass scope:"all" to clear the whole shared buffer.'
      );
    }

    const tree = typeof (firefox as any).getContextTree === 'function' ? (firefox as any).getContextTree() : null;
    const count = firefox.clearConsoleMessages((message) => {
      if (!message.context) {
        return false;
      }
      return tree ? tree.relationTo(message.context, tab) !== null : message.context === tab;
    });

    return successResponse(`✅ cleared ${count} messages from ${tabName(tab)}`);
  } catch (error) {
    return errorResponse(error as Error);
  }
}
