/**
 * Page navigation and management tools for MCP
 */

import { successResponse, errorResponse } from '../utils/response-helpers.js';
import { ensureUnloadPromptsDisabled } from '../utils/unload-guard.js';
import { withNavigationWatchdog, getNavTimeoutMs } from '../utils/nav-watchdog.js';
import type { McpToolResponse } from '../types/common.js';
import { tenancy, tabName, HUMAN_OWNER } from '../tenancy.js';
import { isBiDiUnavailable } from '../firefox/bidi-ops.js';

// Tool definitions
export const listPagesTool = {
  name: 'list_pages',
  description:
    'List every open tab with its stable id and owner, the way ps shows every process on a shared machine. Selected tab is marked.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'mine'],
        description:
          'all (default) lists every tab in the browser including other agents and any a person is using; mine narrows to tabs you own.',
      },
    },
  },
};

export const newPageTool = {
  name: 'new_page',
  description:
    'Open a new tab at URL and take ownership of it. Returns its stable id, which later calls should pass as tab.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Target URL',
      },
    },
    required: ['url'],
  },
};

export const navigatePageTool = {
  name: 'navigate_page',
  description:
    'Navigate a tab to URL. Runs in the background on your own tab by default, so it does not disturb whatever is on screen.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Target URL',
      },
    },
    required: ['url'],
  },
};

export const selectPageTool = {
  name: 'select_page',
  description:
    'Bring a tab to the foreground, changing what a person at the browser sees. Accepts tab id (preferred), index, URL, or title. Other tools act on their tab in the background, so this is only needed to show someone a page.',
  inputSchema: {
    type: 'object',
    properties: {
      pageIdx: {
        type: 'number',
        description: 'Tab index (0-based, most reliable)',
      },
      url: {
        type: 'string',
        description: 'URL substring (case-insensitive)',
      },
      title: {
        type: 'string',
        description: 'Title substring (case-insensitive)',
      },
    },
    required: [],
  },
};

export const closePageTool = {
  name: 'close_page',
  description:
    'Close a tab. Pass tab with its id - an index can point at a different tab by the time the call lands, and closing the wrong one is not recoverable.',
  inputSchema: {
    type: 'object',
    properties: {
      pageIdx: {
        type: 'number',
        description: 'Tab index to close. Only used when no tab id is given.',
      },
    },
  },
};

/**
 * Render the tab list with owners attached.
 *
 * The id column is what callers should pass back: an index moves the moment
 * anyone opens or closes a tab, while the id stays with the tab for its life.
 */
function formatPageList(
  tabs: Array<{ actor: string; title?: string; url?: string }>,
  selectedIdx: number,
  mineOnly: string | null
): string {
  const rows = tabs.map((tab, index) => ({
    index,
    tabId: tab.actor,
    title: (tab.title || 'Untitled').substring(0, 40),
    owner: tenancy.ownerOf(tab.actor),
    url: tab.url || 'about:blank',
  }));

  const visible = mineOnly ? rows.filter((row) => row.owner === mineOnly) : rows;

  if (visible.length === 0) {
    return mineOnly ? '📄 No tabs owned by you' : '📄 No pages';
  }

  const header = mineOnly
    ? `📄 ${visible.length} of ${rows.length} tabs are yours`
    : `📄 ${rows.length} tabs (selected: ${selectedIdx})`;

  const lines: string[] = [header];
  for (const row of visible) {
    const marker = row.index === selectedIdx ? '>' : ' ';
    const owner = row.owner === HUMAN_OWNER ? 'unowned' : row.owner;
    const viewport = tenancy.viewportOf(row.tabId);
    const geometry = viewport ? `  ${viewport.width}x${viewport.height}` : '';
    lines.push(`${marker}[${row.index}] ${tabName(row.tabId)}${geometry}  ${owner}  ${row.title}`);
    lines.push(`      ${row.url}`);
  }
  return lines.join('\n');
}

// Handlers
export async function handleListPages(args: unknown): Promise<McpToolResponse> {
  try {
    const { scope, agent } = (args ?? {}) as { scope?: string; agent?: string };

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    await firefox.refreshTabs();
    const tabs = firefox.getTabs();
    const selectedIdx = firefox.getSelectedTabIdx();

    // The caller's id is stripped before handlers run, so narrowing to "mine"
    // falls back to the most recently seen agent when it is not passed through.
    const mineOnly =
      scope === 'mine'
        ? (agent ?? tenancy.listAgents().sort((a, b) => b.lastSeen - a.lastSeen)[0]?.id ?? null)
        : null;

    return successResponse(formatPageList(tabs, selectedIdx, mineOnly));
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleNewPage(args: unknown): Promise<McpToolResponse> {
  try {
    const { url, agent } = args as { url: string; agent?: string };

    if (!url || typeof url !== 'string') {
      throw new Error('url parameter is required and must be a string');
    }

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    await ensureUnloadPromptsDisabled(firefox);

    // Opening the tab in the background is what stops a new page from yanking
    // the view away from whoever is at the browser. A browser that cannot open
    // tabs that way still opens it, in front, the way it always did.
    const created = await withNavigationWatchdog(
      `new_page → ${url}`,
      getNavTimeoutMs(),
      async () => {
        try {
          return await firefox.createNewPageInBackground(url);
        } catch (error) {
          if (!isBiDiUnavailable(error)) {
            throw error;
          }
          return await firefox.createNewPageWithId(url);
        }
      }
    );

    // The opener knows exactly which tab it made. Recognising it afterwards by
    // whichever tab ended up selected only held while opening a tab also
    // focused it, and would now hand the caller a tab someone else is using.
    if (agent) {
      tenancy.claimTab(created.tabId, agent);
      tenancy.setCursor(agent, created.tabId);
    }

    return successResponse(
      `✅ new page [${created.index}] id ${tabName(created.tabId)} → ${url}`
    );
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleNavigatePage(args: unknown): Promise<McpToolResponse> {
  try {
    const { url, tab } = args as { url: string; tab?: string };

    if (!url || typeof url !== 'string') {
      throw new Error('url parameter is required and must be a string');
    }

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    // Refresh tabs to get latest list
    await firefox.refreshTabs();
    const tabs = firefox.getTabs();
    const selectedIdx = firefox.getSelectedTabIdx();
    const targetId = tab ?? tabs[selectedIdx]?.actor ?? null;

    if (!targetId) {
      throw new Error('No page selected');
    }

    await ensureUnloadPromptsDisabled(firefox);

    // Naming the tab keeps the browser's focus where it is, so this call cannot
    // pull the view away from a person or from another agent mid-task.
    try {
      await withNavigationWatchdog(`navigate_page → ${url}`, getNavTimeoutMs(), () =>
        firefox.navigateInTab(targetId, url)
      );
    } catch (error) {
      if (!isBiDiUnavailable(error)) {
        throw error;
      }
      // A browser without the Remote Agent still navigates, it just has to raise
      // the tab first. Better a moved view than a refused request.
      await firefox.selectTabById(targetId);
      await withNavigationWatchdog(`navigate_page → ${url}`, getNavTimeoutMs(), () =>
        firefox.navigate(url)
      );
    }

    const idx = firefox.indexOfTab(targetId);
    return successResponse(
      `✅ [${idx >= 0 ? idx : selectedIdx}] ${tabName(targetId)} → ${url}`
    );
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleSelectPage(args: unknown): Promise<McpToolResponse> {
  try {
    const { pageIdx, url, title, tab, tabWasNamed } = args as {
      pageIdx?: number;
      url?: string;
      title?: string;
      tab?: string;
      tabWasNamed?: boolean;
    };

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    // Refresh tabs to get latest list
    await firefox.refreshTabs();
    const tabs = firefox.getTabs();

    let selectedIdx: number;

    // Priority 0: a tab the caller named. Ids outrank indices because an index
    // moves the moment any other agent opens or closes a tab. The name has to
    // have been given explicitly - every call carries a tab, and the implicit
    // one is the caller's cursor, which is not what pageIdx meant.
    if (tabWasNamed && tab) {
      const idx = firefox.indexOfTab(tab);
      if (idx < 0) {
        throw new Error(`Tab ${tabName(tab)} is no longer open`);
      }
      selectedIdx = idx;
    }
    // Priority 1: Select by index
    else if (typeof pageIdx === 'number') {
      selectedIdx = pageIdx;
    }
    // Priority 2: Select by URL pattern
    else if (url && typeof url === 'string') {
      const urlLower = url.toLowerCase();
      const foundIdx = tabs.findIndex((tab) => tab.url?.toLowerCase().includes(urlLower));
      if (foundIdx === -1) {
        throw new Error(`No page matching URL "${url}"`);
      }
      selectedIdx = foundIdx;
    }
    // Priority 3: Select by title pattern
    else if (title && typeof title === 'string') {
      const titleLower = title.toLowerCase();
      const foundIdx = tabs.findIndex((tab) => tab.title?.toLowerCase().includes(titleLower));
      if (foundIdx === -1) {
        throw new Error(`No page matching title "${title}"`);
      }
      selectedIdx = foundIdx;
    } else {
      throw new Error('Provide pageIdx, url, or title');
    }

    // Validate the selected index
    if (!tabs[selectedIdx]) {
      throw new Error(`Page [${selectedIdx}] not found`);
    }

    // Select the tab
    await firefox.selectTab(selectedIdx);

    return successResponse(
      `✅ selected [${selectedIdx}] ${tabName(tabs[selectedIdx]!.actor)} - this is now the tab on screen`
    );
  } catch (error) {
    return errorResponse(error as Error);
  }
}

export async function handleClosePage(args: unknown): Promise<McpToolResponse> {
  try {
    const { pageIdx, tab, tabWasNamed } = args as {
      pageIdx?: number;
      tab?: string;
      tabWasNamed?: boolean;
    };

    const { getFirefox } = await import('../index.js');
    const firefox = await getFirefox();

    // Refresh tabs to get latest list
    await firefox.refreshTabs();
    const tabs = firefox.getTabs();

    // Closing is the one place a shifting index does real damage, so a named
    // tab is closed by its id and the index is never consulted.
    if (tabWasNamed && tab) {
      const idx = firefox.indexOfTab(tab);
      if (idx < 0) {
        throw new Error(`Tab ${tabName(tab)} is no longer open`);
      }
      const owner = tenancy.ownerOf(tab);
      await ensureUnloadPromptsDisabled(firefox);
      // Closing a named tab leaves the view where it was, so an agent cleaning
      // up its own tabs no longer drags a person off the page they are reading.
      await withNavigationWatchdog(`close_page ${tabName(tab)}`, getNavTimeoutMs(), async () => {
        try {
          await firefox.closeTabInBackground(tab);
        } catch (error) {
          if (!isBiDiUnavailable(error)) {
            throw error;
          }
          await firefox.closeTabById(tab);
        }
      });
      tenancy.releaseTab(tab);
      const note = owner === HUMAN_OWNER ? ' (it was unowned)' : '';
      return successResponse(`✅ closed [${idx}] ${tabName(tab)}${note}`);
    }

    if (typeof pageIdx !== 'number') {
      throw new Error('Provide tab (preferred) or pageIdx');
    }

    const pageToClose = tabs[pageIdx];

    if (!pageToClose) {
      throw new Error(`Page with index ${pageIdx} not found`);
    }

    await ensureUnloadPromptsDisabled(firefox);
    await withNavigationWatchdog(`close_page [${pageIdx}]`, getNavTimeoutMs(), () =>
      firefox.closeTab(pageIdx)
    );
    tenancy.releaseTab(pageToClose.actor);

    return successResponse(`✅ closed [${pageIdx}] ${tabName(pageToClose.actor)}`);
  } catch (error) {
    return errorResponse(error as Error);
  }
}
