/**
 * Suppresses Firefox's "Leave page?" (beforeunload) prompt.
 *
 * Such a prompt raised by a navigation or a tab close is unrecoverable through
 * the normal dialog tools: the WebDriver command that triggered it never
 * returns, switchTo().alert() cannot reach the prompt so accept and dismiss
 * both fail with "unknown error", and every later command against that tab
 * fails the same way until a different tab is selected. Because the server
 * stops answering while that command hangs, one wedged tab can take down every
 * tool the process exposes.
 *
 * Neutralising the handlers from page JS does not work. beforeunload is
 * dispatched at window, where listeners run in registration order regardless
 * of the capture flag, so a late-added listener cannot pre-empt an earlier
 * one, and there is no way to un-cancel an event another listener already
 * cancelled. The platform pref is the only reliable suppression point.
 *
 * Note this only suppresses the *prompt*. Page beforeunload handlers still run,
 * so analytics and state-saving side effects are unaffected.
 */

import { runInChromeScope } from './chrome-scope.js';
import { log } from './logger.js';

const PREF = 'dom.disable_beforeunload';

let state: 'unknown' | 'disabled' | 'unavailable' = 'unknown';

/** Forget the cached result. Call after a Firefox restart or a reconnect. */
export function resetUnloadGuard(): void {
  state = 'unknown';
}

/**
 * Set the pref once per session, best effort. Never throws: when privileged
 * access is unavailable the navigation watchdog is the remaining protection,
 * and the caller should still attempt its navigation.
 */
export async function ensureUnloadPromptsDisabled(firefox: unknown): Promise<boolean> {
  if (state === 'disabled') return true;
  if (state === 'unavailable') return false;

  try {
    await runInChromeScope(firefox as any, async (driver) => {
      await driver.executeScript(
        `Services.prefs.setBoolPref(${JSON.stringify(PREF)}, true); return true;`
      );
    });
    state = 'disabled';
    log(`${PREF}=true - beforeunload prompts suppressed for this session`);
    return true;
  } catch (error) {
    state = 'unavailable';
    log(
      `Could not set ${PREF} (${error instanceof Error ? error.message : String(error)}). ` +
        'A "Leave page?" prompt can still wedge a tab; the navigation watchdog will report it.'
    );
    return false;
  }
}
