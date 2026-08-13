/**
 * Bulk context bundling.
 *
 * A tool call used to answer exactly what it was asked and nothing else, so
 * finding out what a click had actually done took four more calls: a
 * screenshot, the console, the network log, and a fresh page tree. Each one
 * costs a round trip, and by the time they arrive the page has moved on.
 *
 * The bundle answers them in the same reply. What comes back is scoped to the
 * call that asked for it - console lines and requests are sliced to the window
 * the tool ran in, not the whole session buffer - so the reply describes this
 * action rather than everything the browser has done since it started.
 *
 * Everything here is on by default and turned off by asking. An agent that
 * wants a lean reply says so once per call; an agent that says nothing gets
 * enough to decide its next move without another call.
 */

import { SCREENSHOT_DETAIL_SCHEMA } from './utils/image-scale.js';

type BundleContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' };

export type ContextLevel = 'off' | 'counts' | 'inline' | 'full';

const LEVELS = new Set<string>(['off', 'counts', 'inline', 'full']);

/**
 * How much of each channel survives at each level. A bundle that outgrows the
 * answer it accompanies defeats its own purpose, so every channel is capped
 * rather than trusted to be small.
 */
const CAPS: Record<Exclude<ContextLevel, 'off'>, { console: number; network: number; dom: number }> =
  {
    counts: { console: 0, network: 0, dom: 0 },
    inline: { console: 20, network: 20, dom: 40 },
    full: { console: 200, network: 200, dom: 400 },
  };

/**
 * Arguments every context-capable tool accepts. Injected once at registration
 * so a newly added tool bundles context without being told to.
 */
export const CONTEXT_SCHEMA_PROPERTIES = {
  context: {
    type: 'string',
    enum: ['off', 'counts', 'inline', 'full'],
    description:
      "How much page context to bundle into this reply. 'off' none; 'counts' a single summary line; 'inline' (default) that line plus errors, notable requests and the interactive parts of the page; 'full' everything captured while the tool ran.",
  },
  screenshot: {
    type: 'boolean',
    description:
      'Include a picture of your tab. On by default for calls that change the page. Set false when you already know what it looks like.',
  },
  dom: {
    type: 'boolean',
    description:
      'Include the page tree, with uids you can click straight away. On by default unless the tool already returns one.',
  },
  console: {
    type: 'boolean',
    description: 'Include console output from while this tool ran. On by default.',
  },
  network: {
    type: 'boolean',
    description: 'Include network requests made while this tool ran. On by default.',
  },
  detail: SCREENSHOT_DETAIL_SCHEMA,
};

/** Stripped from the arguments before the handler sees them. */
export const CONTEXT_ARG_KEYS = [
  'context',
  'screenshot',
  'dom',
  'console',
  'network',
  'detail',
] as const;

/**
 * Tools whose reply is about a page. Bundling context onto the others - the
 * ownership tools, the browser-wide reports - would attach a picture of a page
 * to an answer that was never about one.
 */
const CONTEXT_CAPABLE_TOOLS = new Set([
  'navigate_page',
  'new_page',
  'select_page',
  'navigate_history',
  'evaluate_script',
  'evaluate_privileged_script',
  'click_by_uid',
  'hover_by_uid',
  'fill_by_uid',
  'drag_by_uid_to_uid',
  'fill_form_by_uid',
  'upload_file_by_uid',
  'accept_dialog',
  'dismiss_dialog',
  'scroll_page',
  'set_viewport_size',
  'take_snapshot',
  'query_dom',
  'page_info',
  'screenshot_page',
  'screenshot_by_uid',
]);

/** Tools that already return the thing a channel would add. */
const ALREADY_RETURNS_DOM = new Set(['take_snapshot', 'query_dom']);
const ALREADY_RETURNS_SCREENSHOT = new Set(['screenshot_page', 'screenshot_by_uid']);

export function isContextCapable(toolName: string): boolean {
  return CONTEXT_CAPABLE_TOOLS.has(toolName);
}

export interface ContextOptions {
  level: ContextLevel;
  screenshot: boolean;
  dom: boolean;
  console: boolean;
  network: boolean;
}

/**
 * A tool that changed the page has something to show; one that only read it
 * usually does not, and a picture per read call is a lot of tokens for an
 * agent that only asked a question.
 */
export function resolveContextOptions(
  toolName: string,
  raw: Record<string, unknown>,
  opts: { isMutation: boolean }
): ContextOptions {
  const asked = typeof raw.context === 'string' && LEVELS.has(raw.context) ? raw.context : 'inline';
  const level = asked as ContextLevel;

  if (level === 'off') {
    return { level, screenshot: false, dom: false, console: false, network: false };
  }

  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

  const rich = level !== 'counts';

  return {
    level,
    screenshot: bool(
      raw.screenshot,
      rich && opts.isMutation && !ALREADY_RETURNS_SCREENSHOT.has(toolName)
    ),
    dom: bool(raw.dom, rich && !ALREADY_RETURNS_DOM.has(toolName)),
    console: bool(raw.console, true),
    network: bool(raw.network, true),
  };
}

export interface ContextWindow {
  startedAt: number;
}

/**
 * Marks where the tool's own activity begins. The console and network buffers
 * are session-wide and minutes deep, so without a mark the reply to a click
 * would carry every request the page had ever made.
 */
export function openContextWindow(): ContextWindow {
  return { startedAt: Date.now() };
}

/**
 * How an entry relates to the tab the call acted on.
 *
 * Comparing the entry's context to the tab id is not enough: an iframe is a
 * child context and a popup is a sibling one, so a page's own activity mostly
 * arrives under an id that is not the tab's. The tree resolves both. An entry
 * the browser attributed to nothing is withheld rather than assumed to be ours,
 * since in a shared browser it is as likely to belong to somebody else.
 */
function relationIn(
  entry: { context?: string },
  tabId: string | null,
  tree: { relationTo(context: string, tabId: string): 'self' | 'popup' | null } | null
): 'self' | 'popup' | null {
  if (!tabId) {
    return 'self';
  }
  if (!entry.context) {
    return null;
  }
  if (!tree) {
    return entry.context === tabId ? 'self' : null;
  }
  return tree.relationTo(entry.context, tabId);
}

function inWindow(timestamp: unknown, startedAt: number): boolean {
  return typeof timestamp === 'number' && timestamp >= startedAt;
}

/** Roles worth showing when the whole tree is too much to send. */
const INTERACTIVE = /\b(button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|tab|switch|slider|spinbutton|textarea|input|select|form|dialog|alert)\b/i;

function digestTree(formatted: string, cap: number): { lines: string[]; note: string } {
  const all = formatted.split('\n').filter((line) => line.trim().length > 0);

  const interactive = all.filter((line) => INTERACTIVE.test(line));
  // Falls back to the top of the tree when nothing matched: a page with no
  // controls still has a shape worth reporting, and an empty section reads as
  // a broken capture rather than a page with nothing to click.
  const chosen = interactive.length >= 3 ? interactive : all;
  const note = interactive.length >= 3 ? 'interactive elements' : 'page tree';

  return { lines: chosen.slice(0, cap), note: `${note}, ${chosen.length} of ${all.length} lines` };
}

export interface CollectParams {
  toolName: string;
  tabId: string | null;
  options: ContextOptions;
  window: ContextWindow;
  screenshotWaitMs: number;
  log: (message: string) => void;
}

/**
 * Gathers the bundle. Every channel is best-effort on purpose: context is an
 * extra, and a page tree that failed to render must never turn a successful
 * click into a failed tool call.
 */
export async function collectContext(
  ff: any,
  params: CollectParams
): Promise<{ blocks: BundleContent[]; structured: Record<string, unknown> }> {
  const { options, tabId } = params;
  // Absent on a client that predates context tracking, and null whenever BiDi
  // is unavailable; both cases fall back to the old equality check.
  const tree = typeof ff.getContextTree === 'function' ? ff.getContextTree() : null;
  const cap = CAPS[options.level as Exclude<ContextLevel, 'off'>] ?? CAPS.inline;
  const blocks: BundleContent[] = [];
  const structured: Record<string, unknown> = { level: options.level };
  const summary: string[] = [];
  const sections: string[] = [];

  // Console
  if (options.console) {
    try {
      const all = (await ff.getConsoleMessages()) as any[];
      const popups = new Set<any>();
      let hidden = 0;
      const mine = all.filter((msg) => {
        if (!inWindow(msg?.timestamp, params.window.startedAt)) {
          return false;
        }
        const relation = relationIn(msg ?? {}, tabId, tree);
        if (!relation) {
          hidden++;
          return false;
        }
        if (relation === 'popup') {
          popups.add(msg);
        }
        return true;
      });
      const errors = mine.filter((msg) => msg?.level === 'error');
      const warnings = mine.filter((msg) => msg?.level === 'warn' || msg?.level === 'warning');

      summary.push(
        `${mine.length} console` +
          (errors.length > 0 ? ` (${errors.length} error${errors.length === 1 ? '' : 's'})` : '')
      );
      structured.console = {
        total: mine.length,
        errors: errors.length,
        warnings: warnings.length,
        fromPopups: popups.size,
        hiddenOtherTabs: hidden,
      };

      // At the inline level only the lines that suggest something went wrong
      // are worth the tokens; an agent that wants the chatter asks for full.
      const shown = options.level === 'full' ? mine : [...errors, ...warnings];
      if (cap.console > 0 && shown.length > 0) {
        const lines = shown
          .slice(0, cap.console)
          .map(
            (msg) =>
              `  ${popups.has(msg) ? '↗ ' : ''}[${msg?.level ?? 'info'}] ${String(msg?.text ?? '').slice(0, 300)}`
          );
        if (shown.length > cap.console) {
          lines.push(`  [+${shown.length - cap.console} more, use list_console_messages]`);
        }
        if (popups.size > 0) {
          lines.push('  ↗ = a window this tab opened');
        }
        sections.push(`console:\n${lines.join('\n')}`);
      }
    } catch (error) {
      params.log(`Context console channel skipped: ${error}`);
    }
  }

  // Network
  if (options.network) {
    try {
      const all = (await ff.getNetworkRequests()) as any[];
      const popups = new Set<any>();
      let hidden = 0;
      const mine = all.filter((req) => {
        if (!inWindow(req?.timestamp, params.window.startedAt)) {
          return false;
        }
        const relation = relationIn(req ?? {}, tabId, tree);
        if (!relation) {
          hidden++;
          return false;
        }
        if (relation === 'popup') {
          popups.add(req);
        }
        return true;
      });
      const failed = mine.filter((req) => typeof req?.status === 'number' && req.status >= 400);
      const pending = mine.filter((req) => req?.status === undefined);

      summary.push(
        `${mine.length} request${mine.length === 1 ? '' : 's'}` +
          (failed.length > 0 ? ` (${failed.length} failed)` : '')
      );
      structured.network = {
        total: mine.length,
        failed: failed.length,
        pending: pending.length,
        fromPopups: popups.size,
        hiddenOtherTabs: hidden,
      };

      // Anything that failed, plus the calls a page makes on purpose. Images
      // and stylesheets are almost never why an agent is looking.
      const notable =
        options.level === 'full'
          ? mine
          : mine.filter((req) => failed.includes(req) || req?.isXHR || req?.resourceType === 'xhr');
      if (cap.network > 0 && notable.length > 0) {
        const lines = notable
          .slice(0, cap.network)
          .map(
            (req) =>
              `  ${popups.has(req) ? '↗ ' : ''}${req?.status ?? '···'} ${req?.method ?? 'GET'} ${String(req?.url ?? '').slice(0, 160)}`
          );
        if (popups.size > 0) {
          lines.push('  ↗ = a window this tab opened');
        }
        if (notable.length > cap.network) {
          lines.push(`  [+${notable.length - cap.network} more, use list_network_requests]`);
        }
        sections.push(`network:\n${lines.join('\n')}`);
      }
    } catch (error) {
      params.log(`Context network channel skipped: ${error}`);
    }
  }

  // Page tree
  if (options.dom && cap.dom > 0) {
    try {
      const snapshot = tabId
        ? await ff.takeSnapshotInTab(tabId)
        : await ff.takeSnapshot();
      const { formatSnapshotTree } = await import('./firefox/snapshot/formatter.js');
      const formatted = formatSnapshotTree(snapshot.json.root, 0, {
        includeAttributes: options.level === 'full',
        includeText: true,
      });
      const { lines, note } = digestTree(formatted, cap.dom);

      summary.push(`dom id=${snapshot.json.snapshotId}`);
      structured.dom = { snapshotId: snapshot.json.snapshotId, lines: lines.length };

      // The uids below belong to the snapshot just taken, so they can be handed
      // straight to click_by_uid without a take_snapshot call in between.
      sections.push(
        `page tree (id=${snapshot.json.snapshotId}, ${note}):\n${lines.join('\n')}`
      );
    } catch (error) {
      params.log(`Context dom channel skipped: ${error}`);
    }
  }

  // Screenshot
  if (options.screenshot) {
    try {
      const { waitForVisualReady } = await import('./utils/visual-ready.js');
      let waitNote: string | null = null;
      let base64Png: string | null = null;

      // The caller's own tab, not whichever tab the browser happens to be
      // showing - after a background action those are usually different tabs,
      // and the wrong picture is worse than none.
      if (tabId) {
        try {
          waitNote = await ff.waitForTabReady(tabId, params.screenshotWaitMs);
          base64Png = await ff.screenshotTab(tabId);
        } catch {
          base64Png = null;
        }
      }

      if (!base64Png) {
        try {
          waitNote = await waitForVisualReady(ff.getDriver(), params.screenshotWaitMs);
        } catch {
          // Never block the picture on the readiness probe.
        }
        base64Png = await ff.takeScreenshotPage();
      }

      if (base64Png && typeof base64Png === 'string') {
        if (waitNote) {
          blocks.push({ type: 'text', text: waitNote });
        }
        blocks.push({ type: 'image', data: base64Png, mimeType: 'image/png' });
        structured.screenshot = true;
      }
    } catch (error) {
      params.log(`Context screenshot channel skipped: ${error}`);
    }
  }

  const header = summary.length > 0 ? `🧰 ${summary.join(' · ')}` : '🧰 no context captured';
  const body = sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
  const text = `${header}${body}`;
  blocks.unshift({ type: 'text', text });

  // Clients that render structured output ignore the text blocks entirely, so
  // the same report has to travel both ways or half of them see counts with
  // nothing behind them.
  structured.text = text;

  return { blocks, structured };
}
