/**
 * Choosing between acting on a named tab and acting on the focused one.
 *
 * The background route sends the work to the tab the caller named, so nothing
 * moves on screen and concurrent callers stop stealing each other's foreground.
 * A browser that cannot address tabs that way still works - it just has to raise
 * the tab first, which is what the fallback does before handing over.
 */

import { isBiDiUnavailable } from '../firefox/bidi-ops.js';

/**
 * Act on a named tab, falling back to the focused path.
 *
 * Only an unusable channel is worth retrying: an element that was missing, or a
 * page that rejected the action, will answer the same way on either path.
 */
export async function onTabOrFocused<T>(
  firefox: { selectTabById(tabId: string): Promise<void> },
  tab: string | undefined,
  background: (tabId: string) => Promise<T>,
  focused: () => Promise<T>
): Promise<T> {
  if (tab) {
    try {
      return await background(tab);
    } catch (error) {
      if (!isBiDiUnavailable(error)) {
        throw error;
      }
      await firefox.selectTabById(tab);
    }
  }
  return await focused();
}
