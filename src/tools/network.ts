/**
 * Network monitoring tools for Firefox DevTools MCP
 * Provides network request inspection capabilities
 */

import {
  successResponse,
  errorResponse,
  jsonResponse,
  truncateHeaders,
} from '../utils/response-helpers.js';
import type { McpToolResponse } from '../types/common.js';
import { scopeEntries, hiddenNote, SCOPE_SCHEMA_PROPERTY, type ScopeMode } from '../tab-scope.js';
import { tabName } from '../tenancy.js';

// Tool definitions
export const listNetworkRequestsTool = {
  name: 'list_network_requests',
  description:
    'List network requests made by your tab, its frames, and windows it opened. Returns IDs for get_network_request.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description: 'Max requests (default: 50)',
      },
      sinceMs: {
        type: 'number',
        description: 'Only last N ms',
      },
      urlContains: {
        type: 'string',
        description: 'URL filter (case-insensitive)',
      },
      method: {
        type: 'string',
        description: 'HTTP method filter',
      },
      status: {
        type: 'number',
        description: 'Exact status code',
      },
      statusMin: {
        type: 'number',
        description: 'Min status code',
      },
      statusMax: {
        type: 'number',
        description: 'Max status code',
      },
      isXHR: {
        type: 'boolean',
        description: 'XHR/fetch only',
      },
      resourceType: {
        type: 'string',
        description: 'Resource type filter',
      },
      sortBy: {
        type: 'string',
        enum: ['timestamp', 'duration', 'status'],
        description: 'Sort field (default: timestamp)',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'min', 'full'],
        description: 'Detail level (default: summary)',
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

export const getNetworkRequestTool = {
  name: 'get_network_request',
  description: 'Get request details by ID. URL lookup as fallback.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'Request ID from list_network_requests',
      },
      url: {
        type: 'string',
        description: 'URL fallback (may match multiple)',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format (default: text)',
      },
    },
  },
};

// Tool handlers
export async function handleListNetworkRequests(args: unknown): Promise<McpToolResponse> {
  try {
    const {
      limit = 50,
      sinceMs,
      urlContains,
      method,
      status,
      statusMin,
      statusMax,
      isXHR,
      resourceType,
      sortBy = 'timestamp',
      detail = 'summary',
      format = 'text',
      tab,
      scope = 'tab',
    } = (args as {
      limit?: number;
      sinceMs?: number;
      urlContains?: string;
      method?: string;
      status?: number;
      statusMin?: number;
      statusMax?: number;
      isXHR?: boolean;
      resourceType?: string;
      sortBy?: 'timestamp' | 'duration' | 'status';
      detail?: 'summary' | 'min' | 'full';
      format?: 'text' | 'json';
      tab?: string;
      scope?: ScopeMode;
    }) || {};

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    const buffer = (await firefox.getNetworkRequests()) as any[];

    // The buffer holds every tab in a browser shared by several agents, so the
    // caller's own traffic has to be selected before any of the other filters
    // run; otherwise a limit of 8 is 8 rows of somebody else's page.
    const tree = typeof (firefox as any).getContextTree === 'function' ? (firefox as any).getContextTree() : null;
    const scoped = scopeEntries(buffer, scope === 'all' ? null : tab ?? null, tree);
    const withheld = hiddenNote(scoped);
    let requests = scoped.kept;

    // Apply time filter
    if (sinceMs !== undefined) {
      const cutoffTime = Date.now() - sinceMs;
      requests = requests.filter((req) => req.timestamp && req.timestamp >= cutoffTime);
    }

    // Apply filters
    if (urlContains) {
      const urlLower = urlContains.toLowerCase();
      requests = requests.filter((req) => req.url.toLowerCase().includes(urlLower));
    }

    if (method) {
      const methodUpper = method.toUpperCase();
      requests = requests.filter((req) => req.method.toUpperCase() === methodUpper);
    }

    if (status !== undefined) {
      requests = requests.filter((req) => req.status === status);
    }

    if (statusMin !== undefined) {
      requests = requests.filter((req) => req.status !== undefined && req.status >= statusMin);
    }

    if (statusMax !== undefined) {
      requests = requests.filter((req) => req.status !== undefined && req.status <= statusMax);
    }

    if (isXHR !== undefined) {
      requests = requests.filter((req) => req.isXHR === isXHR);
    }

    if (resourceType) {
      const typeLower = resourceType.toLowerCase();
      requests = requests.filter((req) => req.resourceType?.toLowerCase() === typeLower);
    }

    // Sort requests
    if (sortBy === 'timestamp') {
      requests.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    } else if (sortBy === 'duration') {
      requests.sort((a, b) => (b.timings?.duration || 0) - (a.timings?.duration || 0));
    } else if (sortBy === 'status') {
      requests.sort((a, b) => (a.status || 0) - (b.status || 0));
    }

    // Apply limit
    const limitedRequests = requests.slice(0, limit);
    const hasMore = requests.length > limit;

    // Which tab a row belongs to is the one thing a shared buffer cannot be read
    // without, so every output shape carries it.
    const owner = (req: any) => ({
      tab: req.tabRoot ? tabName(req.tabRoot) : null,
      via: req.tabRelation === 'popup' ? 'popup' : null,
    });

    // Format output based on detail level and format
    if (format === 'json') {
      // JSON format - return structured data based on detail level
      const responseData: any = {
        total: requests.length,
        showing: limitedRequests.length,
        hasMore,
        scope,
        hidden: withheld,
        requests: [],
      };

      if (detail === 'summary' || detail === 'min') {
        responseData.requests = limitedRequests.map((req) => ({
          id: req.id,
          url: req.url,
          method: req.method,
          status: req.status,
          statusText: req.statusText,
          resourceType: req.resourceType,
          isXHR: req.isXHR,
          duration: req.timings?.duration,
          ...owner(req),
        }));
      } else {
        // Full detail - apply header truncation to prevent token overflow
        responseData.requests = limitedRequests.map((req) => ({
          id: req.id,
          url: req.url,
          method: req.method,
          status: req.status,
          statusText: req.statusText,
          resourceType: req.resourceType,
          isXHR: req.isXHR,
          timings: req.timings || null,
          requestHeaders: truncateHeaders(req.requestHeaders),
          responseHeaders: truncateHeaders(req.responseHeaders),
          ...owner(req),
        }));
      }

      return jsonResponse(responseData);
    }

    // Text format (default)
    if (detail === 'summary') {
      let sawPopup = false;
      const formattedRequests = limitedRequests.map((req) => {
        const statusInfo = req.status
          ? `[${req.status}${req.statusText ? ' ' + req.statusText : ''}]`
          : '[pending]';
        // Under tab scope every row is the caller's, so only popups need a mark.
        // Listing the whole browser is where a row is meaningless without a name.
        let mark = '';
        if (req.tabRelation === 'popup') {
          sawPopup = true;
          mark = '↗ ';
        } else if (scope === 'all' && req.tabRoot) {
          mark = `[${tabName(req.tabRoot)}] `;
        }
        return `${req.id} | ${mark}${req.method} ${req.url} ${statusInfo}${req.isXHR ? ' (XHR)' : ''}`;
      });

      const header = `📡 ${requests.length} requests${hasMore ? ` (limit ${limit})` : ''}\n`;
      const footer =
        (sawPopup ? `\n↗ = a window your tab opened` : '') + (withheld ? `\n${withheld}` : '');
      return successResponse(header + formattedRequests.join('\n') + footer);
    } else if (detail === 'min') {
      // Compact JSON
      const minData = limitedRequests.map((req) => ({
        id: req.id,
        url: req.url,
        method: req.method,
        status: req.status,
        statusText: req.statusText,
        resourceType: req.resourceType,
        isXHR: req.isXHR,
        duration: req.timings?.duration,
        ...owner(req),
      }));

      return jsonResponse({
        total: requests.length,
        showing: minData.length,
        hasMore: hasMore,
        scope,
        hidden: withheld,
        requests: minData,
      });
    } else {
      // Full JSON including headers - apply truncation to prevent token overflow
      const fullData = limitedRequests.map((req) => ({
        id: req.id,
        url: req.url,
        method: req.method,
        status: req.status,
        statusText: req.statusText,
        resourceType: req.resourceType,
        isXHR: req.isXHR,
        timings: req.timings || null,
        requestHeaders: truncateHeaders(req.requestHeaders),
        responseHeaders: truncateHeaders(req.responseHeaders),
        ...owner(req),
      }));

      return jsonResponse({
        total: requests.length,
        showing: fullData.length,
        hasMore: hasMore,
        scope,
        hidden: withheld,
        requests: fullData,
      });
    }
  } catch (error) {
    return errorResponse(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function handleGetNetworkRequest(args: unknown): Promise<McpToolResponse> {
  try {
    const {
      id,
      url,
      format = 'text',
    } = args as { id?: string; url?: string; format?: 'text' | 'json' };

    if (!id && !url) {
      return errorResponse('id or url required');
    }

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    const requests = await firefox.getNetworkRequests();
    let request = null;

    // Primary path: lookup by ID
    if (id) {
      request = requests.find((req) => req.id === id);
      if (!request) {
        return errorResponse(`ID ${id} not found`);
      }
    } else if (url) {
      // Fallback: lookup by URL (with collision detection)
      const matches = requests.filter((req) => req.url === url);

      if (matches.length === 0) {
        return errorResponse(`URL not found: ${url}`);
      }

      if (matches.length > 1) {
        const ids = matches.map((req) => req.id).join(', ');
        return errorResponse(`Multiple matches, use id: ${ids}`);
      }

      request = matches[0];
    }

    if (!request) {
      return errorResponse('Request not found');
    }

    // Format request details - apply header truncation to prevent token overflow
    const details = {
      id: request.id,
      url: request.url,
      method: request.method,
      status: request.status ?? null,
      statusText: request.statusText ?? null,
      resourceType: request.resourceType ?? null,
      isXHR: request.isXHR ?? false,
      timestamp: request.timestamp ?? null,
      timings: request.timings ?? null,
      requestHeaders: truncateHeaders(request.requestHeaders),
      responseHeaders: truncateHeaders(request.responseHeaders),
    };

    if (format === 'json') {
      return jsonResponse(details);
    }

    return jsonResponse(details);
  } catch (error) {
    return errorResponse(error instanceof Error ? error : new Error(String(error)));
  }
}
