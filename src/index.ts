#!/usr/bin/env node

/**
 * Firefox DevTools MCP Server
 * Model Context Protocol server for Firefox browser automation via WebDriver BiDi
 */

// Load .env file in development mode
if (process.env.NODE_ENV !== 'production') {
  try {
    const { config } = await import('dotenv');
    const result = config();
    if (result.parsed) {
      console.error('📋 Loaded .env file for development');
    }
  } catch {
    // dotenv not required in production
  }
}

import { version } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { SERVER_NAME, SERVER_VERSION } from './config/constants.js';
import { log, logError, logDebug } from './utils/logger.js';
import { parseArguments, parsePrefs } from './cli.js';
import { FirefoxDevTools } from './firefox/index.js';
import type { FirefoxLaunchOptions } from './firefox/types.js';
import * as tools from './tools/index.js';

import { setNavTimeoutMs, DEFAULT_NAV_TIMEOUT_MS } from './utils/nav-watchdog.js';
import type { McpToolResponse } from './types/common.js';
import { startAssetJanitor } from './utils/asset-janitor.js';
import {
  configureScreenshotScale,
  resolveScreenshotEdge,
  shrinkImageBlocks,
  shrinkPngBase64,
} from './utils/image-scale.js';
import {
  tenancy,
  formatEnvelope,
  tabName,
  HUMAN_OWNER,
  type TabView,
} from './tenancy.js';
import { applyTabMarkers } from './firefox/tab-marker.js';
import { digestTab } from './firefox/tab-digest.js';
import {
  CONTEXT_SCHEMA_PROPERTIES,
  CONTEXT_ARG_KEYS,
  isContextCapable,
  resolveContextOptions,
  openContextWindow,
  collectContext,
} from './context-bundle.js';

// Export for direct usage in scripts
export { FirefoxDevTools } from './firefox/index.js';
export { FirefoxDisconnectedError, isDisconnectionError } from './utils/errors.js';

// Validate Node.js version
const [major] = version.substring(1).split('.').map(Number);
if (!major || major < 20) {
  console.error(`Node ${version} is not supported. Please use Node.js >=20.`);
  process.exit(1);
}

// Parse CLI arguments
export const args = parseArguments(SERVER_VERSION);

// Global context (lazy initialized on first tool call)
let firefox: FirefoxDevTools | null = null;
let nextLaunchOptions: FirefoxLaunchOptions | null = null;

/**
 * Reset Firefox instance (used when disconnection is detected)
 */
export function resetFirefox(): void {
  if (firefox) {
    firefox.reset();
    firefox = null;
  }
  log('Firefox instance reset - will reconnect on next tool call');
}

/**
 * Set options for the next Firefox launch
 * Used by restart_firefox tool to change configuration
 */
export function setNextLaunchOptions(options: FirefoxLaunchOptions): void {
  nextLaunchOptions = options;
  log('Next launch options updated');
}

/**
 * Check if Firefox is currently running (without auto-starting)
 */
export function isFirefoxRunning(): boolean {
  return firefox !== null;
}

/**
 * Get Firefox instance if running, null otherwise (no auto-start)
 */
export function getFirefoxIfRunning(): FirefoxDevTools | null {
  return firefox;
}

export async function getFirefox(): Promise<FirefoxDevTools> {
  // If we have an existing instance, verify it's still connected
  if (firefox) {
    const isConnected = await firefox.isConnected();
    if (!isConnected) {
      log('Firefox connection lost, reconnecting...');
      resetFirefox();
    } else {
      return firefox;
    }
  }

  // No existing instance - create new connection
  log('Initializing Firefox DevTools connection...');

  let options: FirefoxLaunchOptions;

  // Use nextLaunchOptions if set (from restart_firefox tool)
  if (nextLaunchOptions) {
    options = nextLaunchOptions;
    nextLaunchOptions = null; // Clear after use
    log('Using custom launch options from restart_firefox');
  } else {
    // Parse environment variables from CLI args (format: KEY=VALUE)
    let envVars: Record<string, string> | undefined;
    if (args.env && Array.isArray(args.env) && args.env.length > 0) {
      envVars = {};
      for (const envStr of args.env as string[]) {
        const [key, ...valueParts] = envStr.split('=');
        if (key && valueParts.length > 0) {
          envVars[key] = valueParts.join('=');
        }
      }
    }

    // Parse preferences from CLI args
    const prefValues = parsePrefs(args.pref);
    const prefs = Object.keys(prefValues).length > 0 ? prefValues : undefined;

    options = {
      firefoxPath: args.firefoxPath ?? undefined,
      headless: args.headless,
      profilePath: args.profilePath ?? undefined,
      viewport: args.viewport ?? undefined,
      args: (args.firefoxArg as string[] | undefined) ?? undefined,
      startUrl: args.startUrl ?? undefined,
      acceptInsecureCerts: args.acceptInsecureCerts,
      connectExisting: args.connectExisting,
      marionettePort: args.marionettePort,
      env: envVars,
      logFile: args.outputFile ?? undefined,
      prefs,
    };
  }

  firefox = new FirefoxDevTools(options);
  try {
    await firefox.connect();
    log('Firefox DevTools connection established');
    return firefox;
  } catch (error) {
    // Clean up before discarding — ensures the geckodriver process is killed
    // and the Marionette session is released. Without this, a failure during
    // BiDi setup (after the WebDriver session is already established) would
    // leave geckodriver running with an active Marionette session, causing
    // "Connection attempt denied because an active session has been found"
    // on the next connect attempt.
    await firefox.close().catch(() => {});
    firefox = null;
    throw error;
  }
}

// Tool handler mapping
const toolHandlers = new Map<string, (input: unknown) => Promise<McpToolResponse>>([
  // Pages
  ['list_pages', tools.handleListPages],
  ['new_page', tools.handleNewPage],
  ['navigate_page', tools.handleNavigatePage],
  ['select_page', tools.handleSelectPage],
  ['close_page', tools.handleClosePage],

  // Tab ownership
  ['claim_tab', tools.handleClaimTab],
  ['release_tab', tools.handleReleaseTab],
  ['list_agents', tools.handleListAgents],

  // Console
  ['list_console_messages', tools.handleListConsoleMessages],
  ['clear_console_messages', tools.handleClearConsoleMessages],

  // Network
  ['list_network_requests', tools.handleListNetworkRequests],
  ['get_network_request', tools.handleGetNetworkRequest],

  // Snapshot
  ['take_snapshot', tools.handleTakeSnapshot],
  ['resolve_uid_to_selector', tools.handleResolveUidToSelector],
  ['clear_snapshot', tools.handleClearSnapshot],

  // Input
  ['click_by_uid', tools.handleClickByUid],
  ['hover_by_uid', tools.handleHoverByUid],
  ['fill_by_uid', tools.handleFillByUid],
  ['drag_by_uid_to_uid', tools.handleDragByUidToUid],
  ['fill_form_by_uid', tools.handleFillFormByUid],
  ['upload_file_by_uid', tools.handleUploadFileByUid],

  // Screenshot
  ['screenshot_page', tools.handleScreenshotPage],
  ['screenshot_by_uid', tools.handleScreenshotByUid],

  // DOM query / scroll / recording (v0.2.0 max-access set)
  ['query_dom', tools.handleQueryDom],
  ['scroll_page', tools.handleScrollPage],
  ['page_info', tools.handlePageInfo],
  ['start_recording', tools.handleStartRecording],
  ['stop_recording', tools.handleStopRecording],

  // Utilities
  ['accept_dialog', tools.handleAcceptDialog],
  ['dismiss_dialog', tools.handleDismissDialog],
  ['navigate_history', tools.handleNavigateHistory],
  ['set_viewport_size', tools.handleSetViewportSize],

  // Firefox Management
  ['get_firefox_output', tools.handleGetFirefoxLogs],
  ['get_firefox_info', tools.handleGetFirefoxInfo],
  ['restart_firefox', tools.handleRestartFirefox],

  // WebExtensions (install/uninstall use standard BiDi, no privileged context required)
  ['install_extension', tools.handleInstallExtension],
  ['uninstall_extension', tools.handleUninstallExtension],

  // Script evaluation — requires --enable-script
  ...(args.enableScript ? ([['evaluate_script', tools.handleEvaluateScript]] as const) : []),

  // Privileged context tools — requires --enable-privileged-context
  ...(args.enablePrivilegedContext
    ? ([
        ['list_privileged_contexts', tools.handleListPrivilegedContexts],
        ['select_privileged_context', tools.handleSelectPrivilegedContext],
        ['evaluate_privileged_script', tools.handleEvaluatePrivilegedScript],
        ['set_firefox_prefs', tools.handleSetFirefoxPrefs],
        ['get_firefox_prefs', tools.handleGetFirefoxPrefs],
        ['list_extensions', tools.handleListExtensions],
      ] as const)
    : []),

  // Host-network bridge tools — requires --enable-bridge
  ...(args.enableBridge
    ? ([
        ['connect_host_network', tools.handleConnectHostNetwork],
        ['disconnect_host_network', tools.handleDisconnectHostNetwork],
      ] as const)
    : []),
]);

/**
 * Arguments every tool accepts, injected once here rather than repeated across
 * each definition, so a newly registered tool is multi-agent aware by default.
 */
const TENANCY_SCHEMA_PROPERTIES = {
  agent: {
    type: 'string',
    description:
      'Your agent id, as returned in the envelope of any earlier response. Omit on your first call and one will be issued to you.',
  },
  agentLabel: {
    type: 'string',
    description:
      'Optional readable name shown next to your id, e.g. what you are working on. Helps a person reading the browser tell agents apart.',
  },
  tab: {
    type: 'string',
    description:
      'Tab id to act on, taken from an envelope or from list_pages. Defaults to your own most recent tab. Tabs owned by others are reachable but warn.',
  },
};

function withTenancySchema<T extends { name: string; inputSchema: Record<string, any> }>(
  tool: T
): T {
  const schema = tool.inputSchema ?? { type: 'object', properties: {} };
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...((schema.properties as Record<string, unknown>) ?? {}),
        ...TENANCY_SCHEMA_PROPERTIES,
        // Only tools whose answer is about a page can bundle one. Offering the
        // knobs everywhere would invite an agent to ask for a screenshot from a
        // call that has no page to photograph.
        ...(isContextCapable(tool.name) ? CONTEXT_SCHEMA_PROPERTIES : {}),
      },
    },
  };
}

// All tool definitions
const baseTools = [
  // Pages
  tools.listPagesTool,
  tools.newPageTool,
  tools.navigatePageTool,
  tools.selectPageTool,
  tools.closePageTool,

  // Tab ownership
  tools.claimTabTool,
  tools.releaseTabTool,
  tools.listAgentsTool,

  // Console
  tools.listConsoleMessagesTool,
  tools.clearConsoleMessagesTool,

  // Network
  tools.listNetworkRequestsTool,
  tools.getNetworkRequestTool,

  // Snapshot
  tools.takeSnapshotTool,
  tools.resolveUidToSelectorTool,
  tools.clearSnapshotTool,

  // Input
  tools.clickByUidTool,
  tools.hoverByUidTool,
  tools.fillByUidTool,
  tools.dragByUidToUidTool,
  tools.fillFormByUidTool,
  tools.uploadFileByUidTool,

  // Screenshot
  tools.screenshotPageTool,
  tools.screenshotByUidTool,

  // DOM query / scroll / recording (v0.2.0 max-access set)
  tools.queryDomTool,
  tools.scrollPageTool,
  tools.pageInfoTool,
  tools.startRecordingTool,
  tools.stopRecordingTool,

  // Utilities
  tools.acceptDialogTool,
  tools.dismissDialogTool,
  tools.navigateHistoryTool,
  tools.setViewportSizeTool,

  // Firefox Management
  tools.getFirefoxLogsTool,
  tools.getFirefoxInfoTool,
  tools.restartFirefoxTool,

  // WebExtensions (install/uninstall use standard BiDi, no privileged context required)
  tools.installExtensionTool,
  tools.uninstallExtensionTool,

  // Script evaluation — requires --enable-script
  ...(args.enableScript ? [tools.evaluateScriptTool] : []),

  // Privileged context tools — requires --enable-privileged-context
  ...(args.enablePrivilegedContext
    ? [
        tools.listPrivilegedContextsTool,
        tools.selectPrivilegedContextTool,
        tools.evaluatePrivilegedScriptTool,
        tools.setFirefoxPrefsTool,
        tools.getFirefoxPrefsTool,
        tools.listExtensionsTool,
      ]
    : []),

  // Host-network bridge tools — requires --enable-bridge
  ...(args.enableBridge
    ? [tools.connectHostNetworkTool, tools.disconnectHostNetworkTool]
    : []),
];

const allTools = baseTools.map((tool) => withTenancySchema(tool as any));

async function main() {
  log(`Starting ${SERVER_NAME} v${SERVER_VERSION}`);
  log(`Node.js ${version}`);

  // Log configuration
  logDebug(`Configuration:`);
  logDebug(`  Headless: ${args.headless}`);
  if (args.firefoxPath) {
    logDebug(`  Firefox Path: ${args.firefoxPath}`);
  }
  if (args.viewport) {
    logDebug(`  Viewport: ${args.viewport.width}x${args.viewport.height}`);
  }

  await startTransports();
}

/**
 * Builds a fully wired MCP server instance.
 *
 * Split out of main() because HTTP mode needs one Server per client session:
 * an SDK Server owns exactly one transport, and a transport owns exactly one
 * session. The Firefox connection stays module-global on purpose, so every
 * session drives the same browser.
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log('Listing available tools');
    return {
      tools: allTools,
    };
  });

  // Mutation tools that auto-append a screenshot after execution
  const MUTATION_TOOLS = new Set([
    'navigate_page',
    'new_page',
    'click_by_uid',
    'hover_by_uid',
    'fill_by_uid',
    'drag_by_uid_to_uid',
    'fill_form_by_uid',
    'upload_file_by_uid',
    'accept_dialog',
    'dismiss_dialog',
    'navigate_history',
    'set_viewport_size',
    'scroll_page',
  ]);

  // Max ms the auto-screenshot waits for visual readiness (0 = disabled).
  // Captured here because `args` is shadowed inside the CallTool handler.
  const screenshotWaitMs = Math.max(0, Number(args.screenshotWaitMs ?? 8000) || 0);

  // How big a picture is allowed to be by the time it reaches a reader. Set
  // once here so every path that can emit one - the screenshot tools, the
  // bundle attached to a mutation, the picture attached to a refusal - is
  // answering to the same budget.
  configureScreenshotScale({
    explicit: Number(args.screenshotMaxEdge ?? 1024),
    auto: Number(args.screenshotAutoMaxEdge ?? 800),
  });

  // Bound the document-unloading commands so a modal the driver cannot reach
  // fails fast with a diagnostic instead of hanging every tool in the process.
  setNavTimeoutMs(Number(args.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS));

  // Tools that can change which tabs exist, beyond the mutation set above.
  // Ownership changes are in here too: they change no tabs, but they do change
  // what colour every tab should be wearing over VNC, and list_pages doubles as
  // the way to force a repaint by hand.
  const TAB_CHANGING_TOOLS = new Set([
    'close_page',
    'select_page',
    'list_pages',
    'claim_tab',
    'release_tab',
  ]);

  // Tools that name the tab they act on in the request itself. Raising that tab
  // first would undo the whole point, so these leave the foreground alone and a
  // person keeps whatever they were looking at. Every one of them falls back to
  // the classic path on its own terms, and that fallback raises the tab itself.
  const BACKGROUND_CAPABLE_TOOLS = new Set([
    'new_page',
    'close_page',
    'navigate_page',
    'evaluate_script',
    'screenshot_page',
    'click_by_uid',
    'hover_by_uid',
    'fill_by_uid',
    'drag_by_uid_to_uid',
    'fill_form_by_uid',
    'upload_file_by_uid',
    'screenshot_by_uid',
    'take_snapshot',
    'list_pages',
    'list_agents',
    'claim_tab',
    'release_tab',
  ]);

  // Tools that bring their own tab into being, or report on the browser as a
  // whole. Warning them about which tab they defaulted to is noise: they were
  // never going to act on it.
  const TAB_AGNOSTIC_TOOLS = new Set([
    'new_page',
    'list_pages',
    'list_agents',
    'get_firefox_info',
    'get_firefox_logs',
    'restart_firefox',
  ]);

  // Tools that change who holds a tab without touching what it displays.
  // They mutate, so they belong in the mutation set, but a breadcrumb saying
  // the page may have moved would be a lie: claiming a tab leaves the document
  // exactly as it was.
  const OWNERSHIP_TOOLS = new Set(['claim_tab', 'release_tab']);

  /**
   * Whether a call could have changed what a tab is showing - the only kind
   * worth leaving a breadcrumb for. Excludes tools that bring their own tab
   * (the tab resolved for them is a bystander, not a target) and tools that
   * only move ownership around.
   */
  const changesPageContent = (tool: string): boolean =>
    MUTATION_TOOLS.has(tool) && !TAB_AGNOSTIC_TOOLS.has(tool) && !OWNERSHIP_TOOLS.has(tool);

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const { name, arguments: args } = request.params;
    log(`Executing tool: ${name}`);

    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Identity and tab targeting resolve before the tool runs; the tenancy
    // arguments are then stripped so each handler keeps its original shape.
    const rawArgs = (args ?? {}) as Record<string, unknown>;
    const { agent: agentArg, agentLabel, tab: tabArg, ...rest } = rawArgs;

    // The context knobs are answered here, not by the handlers, so every tool
    // keeps the argument shape it was written with.
    const toolArgs: Record<string, unknown> = { ...rest };
    for (const key of CONTEXT_ARG_KEYS) {
      delete toolArgs[key];
    }
    const contextOptions = resolveContextOptions(name, rawArgs, {
      isMutation: MUTATION_TOOLS.has(name),
    });

    // A picture asked for by name is worth more resolution than one handed
    // over unasked, so the two carry different budgets unless the call names a
    // detail level of its own.
    const screenshotEdge = resolveScreenshotEdge(
      rawArgs.detail,
      name === 'screenshot_page' || name === 'screenshot_by_uid' ? 'explicit' : 'auto'
    );
    const { agent, minted, warning: agentWarning } = tenancy.resolveAgent(agentArg, agentLabel);
    const warnings: string[] = [];
    if (agentWarning) {
      warnings.push(agentWarning);
    }

    let tabs: TabView[] = [];
    let targetTab: TabView | null = null;
    let tabWasNamed = false;
    // True when the tab in hand was assumed from whatever the browser had in
    // front rather than requested or owned. Nothing that writes is allowed to
    // use one.
    let targetIsFallback = false;
    // Whether the tab list was observed before the tool ran. Without that
    // baseline there is no way to tell a tab this call opened from one that was
    // already there, and guessing would hand a person's tabs to an agent.
    let baselineKnown = false;

    // Tab work only happens once a browser exists. Resolving it unconditionally
    // would launch Firefox for tools that never needed it.
    let running = getFirefoxIfRunning();

    // A caller that named a tab plainly needs the browser. Skipping resolution
    // here - which is what happens on the first call after a restart - would
    // drop the name silently and send the call to whatever tab is in front.
    if (!running && typeof tabArg === 'string' && tabArg.trim()) {
      try {
        running = await getFirefox();
      } catch (launchError) {
        log(`Could not reach the browser to resolve tab "${tabArg}": ${launchError}`);
      }
    }

    if (running) {
      try {
        await running.refreshTabs();
        tabs = tenancy.decorateTabs(running.getTabs());
        baselineKnown = true;
        tenancy.pruneClosedTabs(tabs.map((tab) => tab.tabId));

        const resolved = tenancy.resolveTab(agent.id, tabArg, tabs, running.getSelectedTabIdx());

        // Acting on some other tab is worse than refusing: the caller would be
        // told the work succeeded while it happened somewhere they never named.
        if (tabArg && !resolved.tabId) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `❌ ${resolved.warning ?? `tab "${String(tabArg)}" not found`}`,
              },
              {
                type: 'text' as const,
                text: formatEnvelope({ agent, minted, tab: null, tabs, warnings }),
              },
            ],
          };
        }

        // The ownership tools are about to change the answer, so reporting who
        // holds the tab as it stands would contradict the very next line of
        // their own output.
        const ownershipTool = OWNERSHIP_TOOLS.has(name);

        if (
          resolved.warning &&
          !ownershipTool &&
          !(resolved.implicit && TAB_AGNOSTIC_TOOLS.has(name))
        ) {
          warnings.push(resolved.warning);
        }
        targetTab = resolved.view;
        tabWasNamed = !resolved.implicit;

        // Point the browser at the caller's own tab so concurrent agents stop
        // racing over whichever tab happens to be focused. Nothing moves when
        // the fallback picked a tab for them - that path only warns, which
        // keeps a person's VNC tab out of reach of an agent that never asked
        // for it.
        // Tools that write to a page, minus the ones that bring their own tab
        // into being or report on the browser as a whole.
        const writesToPage = MUTATION_TOOLS.has(name) && !TAB_AGNOSTIC_TOOLS.has(name);

        // The whole point of the exercise. A write that got here by falling
        // back to the focused tab is a write with no stated target: the caller
        // named nothing and owns nothing, so "where" was answered by whatever
        // happened to be on screen at that instant. Warning about it was tried
        // and did not work - an agent mid-task reads the warning, keeps its
        // own idea of which tab it is on, and drives somebody else's page.
        // Refusing costs the caller one extra call and costs everyone else
        // nothing.
        if (writesToPage && resolved.source === 'fallback' && resolved.view) {
          const victim = resolved.view;
          const heldByOther = victim.owner !== HUMAN_OWNER;
          const ownerLabel = heldByOther ? victim.owner : 'nobody - a person may be using it';
          const mine = tabs.filter((tab) => tab.owner === agent.id);

          // Read the page before saying no. An agent told only "not yours"
          // calls straight back to find out what it nearly touched, so the
          // refusal has to arrive already answering that.
          const digest = await digestTab(running, victim.tabId).catch(() => null);

          const options = [`  new_page  - open a tab of your own (recommended)`];
          if (mine.length > 0) {
            options.push(
              `  tab:"${tabName(mine[0]!.tabId)}"  - act on a tab you already hold${
                mine.length > 1
                  ? ` (you hold ${mine.length}: ${mine.map((t) => tabName(t.tabId)).join(', ')})`
                  : ''
              }`
            );
          }
          options.push(
            `  tab:"${tabName(victim.tabId)}"  - act on this tab anyway, having seen what it is`
          );
          options.push(
            `  claim_tab ${tabName(victim.tabId)}  - take it over for the rest of your session`
          );

          const refusal: Array<
            { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
          > = [
            {
              type: 'text' as const,
              text: [
                `❌ ${name} refused: no tab given, and you hold ${
                  mine.length === 0 ? 'none' : `${mine.length}`
                }.`,
                `Running it would have acted on a tab you did not ask for:`,
                ``,
                `  tab    ${tabName(victim.tabId)}`,
                `  title  ${victim.title}`,
                `  url    ${victim.url}`,
                `  owner  ${ownerLabel}`,
                ...(digest
                  ? [
                      `  page   ${digest.links} links, ${digest.controls} form controls`,
                      `  text   ${digest.text || '(no visible text)'}`,
                    ]
                  : []),
                ``,
                `That is what is on the tab, plus a screenshot where your client`,
                `shows one - deciding what to do next needs no further calls.`,
                `Pick one:`,
                ...options,
              ].join('\n'),
            },
          ];

          // Best-effort: an unreachable page is a reason to say less, never a
          // reason to turn a refusal into a crash.
          try {
            const shot = await running.screenshotTab(victim.tabId);
            if (shot) {
              refusal.push({
                type: 'image' as const,
                data: shrinkPngBase64(shot, screenshotEdge),
                mimeType: 'image/png',
              });
            }
          } catch (shotError) {
            log(`Refusal screenshot failed for ${tabName(victim.tabId)}: ${shotError}`);
          }

          refusal.push({
            type: 'text' as const,
            text: formatEnvelope({
              agent,
              minted,
              tab: victim,
              tabs,
              warnings,
              lastWriter: tenancy.lastActionOn(victim.tabId),
            }),
          });

          return { isError: true, content: refusal };
        }

        targetIsFallback = resolved.source === 'fallback';

        // Naming an unowned tab is informed consent, so the tab becomes the
        // caller's. Without this an agent can work a tab all session and still
        // be counted as holding nothing, which is the state that makes the
        // fallback reachable in the first place.
        if (resolved.tabId && resolved.source === 'explicit' && resolved.view) {
          if (resolved.view.owner === HUMAN_OWNER && writesToPage) {
            tenancy.claimTab(resolved.tabId, agent.id);
          }
        }

        if (resolved.tabId && !targetIsFallback) {
          if (!BACKGROUND_CAPABLE_TOOLS.has(name)) {
            await running.selectTabById(resolved.tabId);
          }
          // The cursor moves either way, so the caller's next call lands on the
          // same tab whether or not the browser ever showed it. This is what
          // stops the target being re-decided against live focus on every call.
          tenancy.setCursor(agent.id, resolved.tabId);
        }
      } catch (tenancyError) {
        log(`Tab resolution skipped for ${name}: ${tenancyError}`);
      }
    }

    const finalize = async (result: McpToolResponse): Promise<McpToolResponse> => {
      const active = getFirefoxIfRunning();

      // Recorded against the tab as it was before the refresh below moves the
      // cursor around, and only when the call could actually have changed the
      // page. This is what lets the next caller be told the tab moved under
      // them instead of having to work it out from the content.
      //
      // The tool set matters more than it looks. `new_page` mutates, but the
      // tab resolved for it is whatever happened to be in front - not the tab
      // it goes on to create. Stamping that one leaves a breadcrumb accusing
      // an agent of touching a page it never opened, which is worse than no
      // breadcrumb at all: the next caller reads it and distrusts a tab that
      // never changed.
      if (targetTab && changesPageContent(name) && !result.isError) {
        tenancy.recordAction(targetTab.tabId, agent.id, name);
      }

      if (active && (MUTATION_TOOLS.has(name) || TAB_CHANGING_TOOLS.has(name))) {
        try {
          await active.refreshTabs();
          const after = tenancy.decorateTabs(active.getTabs());

          // A tab that appeared while this call was running was opened by it, so
          // it belongs to the caller. Tabs a person opens at the VNC session
          // appear between calls and therefore stay unowned - which is also why
          // this only runs when the list was seen beforehand. On the very first
          // call the browser may already be full of someone else's tabs.
          if (baselineKnown) {
            const before = new Set(tabs.map((tab) => tab.tabId));
            const opened = after.filter((tab) => !before.has(tab.tabId));
            for (const tab of opened) {
              tenancy.claimTab(tab.tabId, agent.id);
            }
            if (opened.length > 0) {
              tenancy.setCursor(agent.id, opened[opened.length - 1]!.tabId);
            }
          }

          tenancy.pruneClosedTabs(after.map((tab) => tab.tabId));
          tabs = tenancy.decorateTabs(active.getTabs());

          // Repaint the ownership marks a person sees over VNC. A navigation
          // discards the badge along with the old document, a fresh tab has
          // never had one, and a tab that changed hands is wearing the wrong
          // colour - so the whole list is refreshed rather than guessed at.
          // Tabs a person opened by hand get marked here too, which is the
          // only moment the server learns they exist.
          try {
            await applyTabMarkers(
              active,
              tabs.map((tab) => ({ tabId: tab.tabId, owner: tab.owner }))
            );
          } catch (markerError) {
            log(`Tab marker repaint failed after ${name}: ${markerError}`);
          }
          // A tab that no longer exists cannot be reported as where the caller
          // is - closing one has to leave the envelope saying "no tab" rather
          // than naming the tab that was just destroyed.
          const cursor = tenancy.getAgent(agent.id)?.cursorTabId ?? null;
          targetTab =
            tabs.find((tab) => tab.tabId === cursor) ??
            tabs.find((tab) => tab.tabId === targetTab?.tabId) ??
            null;
        } catch (refreshError) {
          log(`Post-call tab refresh failed for ${name}: ${refreshError}`);
        }
      }

      const envelope = formatEnvelope({
        agent,
        minted,
        tab: targetTab,
        tabs,
        warnings,
        lastWriter: tenancy.lastActionOn(targetTab?.tabId),
      });
      const content = Array.isArray(result.content) ? [...result.content] : [];
      content.push({ type: 'text' as const, text: envelope });

      // Clients that understand structured output render it instead of the text
      // blocks, so a tool returning one would drop the envelope entirely - and
      // an agent that never sees its own id cannot pass it back.
      if (result.structuredContent && typeof result.structuredContent === 'object') {
        return {
          ...result,
          content,
          structuredContent: {
            ...(result.structuredContent as Record<string, unknown>),
            agent: agent.id,
            envelope,
          },
        };
      }

      return { ...result, content };
    };

    // Handlers see the resolved identity and the full tab id rather than the
    // raw arguments, so a caller that passed a short id or an index still ends
    // up acting on the same tab the envelope reports.
    const handlerArgs: Record<string, unknown> = {
      ...toolArgs,
      agent: agent.id,
      tabWasNamed,
    };
    // A tab the server merely assumed is never handed to a tool that writes.
    // The refusal above already turns that case away; this is the backstop for
    // the tools exempt from it, and for whatever gets added to the mutation set
    // later by someone who has not read this file.
    if (targetTab && !(targetIsFallback && MUTATION_TOOLS.has(name))) {
      handlerArgs.tab = targetTab.tabId;
    }

    // Marks where this call's own console output and network traffic begin.
    // The buffers behind them are session-wide and minutes deep, so without the
    // mark a reply would carry everything the browser had ever done.
    const contextWindow = openContextWindow();

    try {
      const result = await handler(handlerArgs);

      // Context is gathered after the tool ran, against the tab the caller
      // ended up on. A failed call is left alone: what it needs to explain
      // itself is the error, not a picture of a page that never changed.
      if (isContextCapable(name) && contextOptions.level !== 'off' && !result.isError) {
        try {
          const ff = await getFirefox();
          const bundleTab = tenancy.getAgent(agent.id)?.cursorTabId ?? targetTab?.tabId ?? null;

          // A recording already owns the screen; capturing frames underneath it
          // corrupts what it is recording.
          const options = tools.isRecording()
            ? { ...contextOptions, screenshot: false }
            : contextOptions;

          const { blocks, structured } = await collectContext(ff, {
            toolName: name,
            tabId: bundleTab,
            options,
            window: contextWindow,
            screenshotWaitMs,
            log,
          });

          if (blocks.length > 0) {
            const content = Array.isArray(result.content) ? [...result.content] : [];
            content.push(...blocks);
            const merged: McpToolResponse = { ...result, content };
            // Clients that understand structured output render it instead of the
            // text blocks, so the bundle has to appear in both or half of them
            // would see nothing.
            if (result.structuredContent && typeof result.structuredContent === 'object') {
              merged.structuredContent = {
                ...(result.structuredContent as Record<string, unknown>),
                context: structured,
              };
            }
            return shrinkImageBlocks(await finalize(merged), screenshotEdge);
          }
        } catch (contextError) {
          log(`Context bundle failed for ${name}: ${contextError}`);
          // A missing bundle is never a reason to fail the call it accompanied.
        }
      }

      return shrinkImageBlocks(await finalize(result), screenshotEdge);
    } catch (error) {
      logError(`Error executing tool ${name}`, error);
      throw error;
    }
  });

  // List resources (not implemented for this server)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: [] };
  });

  // Read resource (not implemented for this server)
  server.setRequestHandler(ReadResourceRequestSchema, async () => {
    throw new Error('Resource reading not implemented');
  });

  return server;
}

async function startTransports() {
  // Recording frames and browser logs pile up for the life of the container,
  // long after the call that produced them was answered.
  startAssetJanitor(undefined, log);

  const useHttp = Boolean(args.http);
  let httpServer: http.Server | null = null;
  let stdioServer: Server | null = null;

  // One transport -- and one Server -- per client session. A single shared
  // transport is not viable: a transport owns exactly one session, so a second
  // client, or the same client after a reconnect, has its initialize rejected
  // and the endpoint stays dead until the process restarts. Every session
  // drives the same module-global Firefox connection.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  if (useHttp) {
    const bearer = String(args.token ?? '');
    const port = Number(args.port ?? 8931);
    const bindHost = String(args.host ?? '0.0.0.0');

    const openSession = async (): Promise<StreamableHTTPServerTransport> => {
      const httpOptions: StreamableHTTPServerTransportOptions = {
        sessionIdGenerator: () => randomUUID(),
      };
      const transport = new StreamableHTTPServerTransport(httpOptions);
      transport.onclose = () => {
        const closedId = transport.sessionId;
        if (closedId && sessions.delete(closedId)) {
          log(`MCP session closed: ${closedId} (${sessions.size} active)`);
        }
      };
      // The SDK types onclose/onerror/onmessage as accessors returning
      // `| undefined`, which does not structurally satisfy Transport's optional
      // members under exactOptionalPropertyTypes. Runtime shape is correct.
      await createMcpServer().connect(transport as unknown as Transport);
      return transport;
    };

    const handleMcpRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const rawId = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(rawId) ? rawId[0] : rawId;

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          // Correct answer for a session this process no longer holds, e.g. a
          // long-lived client that outlived a server restart. Clients treat 404
          // as "re-initialize", which is exactly the recovery wanted here.
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            })
          );
          return;
        }
        await existing.handleRequest(req, res);
        return;
      }

      // No session header, so this should be an initialize. Hand it a fresh
      // transport, then record whatever session id the SDK assigned while
      // handling it. handleRequest branches on GET/POST/DELETE internally, so
      // one call covers the whole streamable-http surface.
      const transport = await openSession();
      await transport.handleRequest(req, res);
      const openedId = transport.sessionId;
      if (openedId) {
        sessions.set(openedId, transport);
        log(`MCP session opened: ${openedId} (${sessions.size} active)`);
      }
    };

    httpServer = http.createServer((req, res) => {
      const url = req.url ?? '/';

      // Unauthenticated so container healthchecks do not need the token.
      if (url === '/health' || url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            server: SERVER_NAME,
            version: SERVER_VERSION,
            sessions: sessions.size,
          })
        );
        return;
      }

      if (!url.startsWith('/mcp')) {
        res.writeHead(404).end();
        return;
      }

      if (bearer && req.headers.authorization !== `Bearer ${bearer}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      void handleMcpRequest(req, res).catch((error: unknown) => {
        logError('HTTP transport request failed', error);
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    });

    const listener = httpServer;
    await new Promise<void>((resolveListen, rejectListen) => {
      listener.once('error', rejectListen);
      listener.listen(port, bindHost, () => {
        listener.off('error', rejectListen);
        resolveListen();
      });
    });

    log(`Firefox DevTools MCP server running on http://${bindHost}:${port}/mcp`);
    log(bearer ? 'Bearer auth enabled' : 'Bearer auth DISABLED (no --token supplied)');
  } else {
    stdioServer = createMcpServer();
    await stdioServer.connect(new StdioServerTransport());
    log('Firefox DevTools MCP server running on stdio');
  }

  log('Ready to accept tool requests');

  // Clean up the Marionette session so Firefox accepts new connections.
  // Without this, the session stays locked after the MCP client disconnects.
  const cleanup = async () => {
    if (httpServer) {
      const listener = httpServer;
      await new Promise<void>((done) => listener.close(() => done()));
    }
    for (const transport of sessions.values()) {
      try {
        await transport.close();
      } catch {
        // ignore
      }
    }
    sessions.clear();
    if (firefox) {
      try {
        await firefox.close();
      } catch {
        // ignore
      }
    }
    if (stdioServer) {
      await stdioServer.close();
    }
    process.exit(0);
  };
  const onSignal = () => void cleanup();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  if (!useHttp) {
    // StdioServerTransport does not fire onclose on stdin EOF.
    // Under HTTP these would fire immediately in a container (no stdin is
    // attached) and shut the server down before it served a single request.
    process.stdin.on('end', onSignal);
    process.stdin.on('close', onSignal);
  }
}

// Only run main() if this file is executed directly (not imported)
// In ES modules, check if import.meta.url matches the executed file
// We need to normalize both paths to handle different execution contexts (npx, node, etc.)
const modulePath = fileURLToPath(import.meta.url);
const scriptPath = process.argv[1] ? resolve(process.argv[1]) : '';

// Resolve both paths fully to handle symlinks and path normalization
let isMainModule = false;
try {
  const realModulePath = realpathSync(modulePath);
  const realScriptPath = scriptPath ? realpathSync(scriptPath) : '';
  isMainModule = realModulePath === realScriptPath;
} catch {
  // If realpath fails (e.g., file doesn't exist), fall back to simple comparison
  isMainModule = modulePath === scriptPath;
}

if (isMainModule) {
  main().catch((error) => {
    logError('Fatal error in main', error);
    process.exit(1);
  });
}
