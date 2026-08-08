/**
 * Making tab ownership visible to a person watching over VNC.
 *
 * Agent ids only ever appear in tool responses, which is fine for the agent and
 * useless for the human looking at the screen: the browser shows a row of tabs
 * with no hint of who is driving which. Two marks fix that without asking
 * Firefox for anything it does not already do.
 *
 * The badge is a small fixed-position label in the page, readable at a glance
 * once a tab is in front. The favicon is a flat colour block, readable across
 * the whole tab strip without clicking anything. Both derive their colour from
 * the owning agent's id, and both fall back to grey when no agent holds the
 * tab - so a tab opened by hand at the VNC session stays visibly neutral.
 *
 * Everything here is best-effort. A privileged page, a document that has not
 * loaded, or a tab that closed mid-call all fail the same way: silently. A
 * missing decoration is never worth failing the call it rode along with.
 */

import { agentColor, HUMAN_OWNER, shortTabId, UNOWNED_COLOR } from '../tenancy.js';

/**
 * Element id of the injected badge. The DOM walkers skip it by name: an agent
 * asking what is on the page should not be shown the server's own furniture,
 * and a uid pointing at it would be a click target that does nothing.
 */
export const TAB_BADGE_ID = '__ff_mcp_tab_badge__';

/** Marks the favicon link so a re-apply replaces its own work, not the page's. */
export const TAB_FAVICON_ID = '__ff_mcp_tab_favicon__';

export interface TabMarkerHost {
  evaluateInTab(tabId: string, functionDeclaration: string): Promise<unknown>;
}

/** A flat rounded square in the owner's colour, small enough to be a favicon. */
function faviconDataUri(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<rect width="16" height="16" rx="4" fill="${color}"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Paint a tab with its owner's colour and id.
 *
 * Re-applying is the normal case, not the exception: a page navigation throws
 * the badge away with the rest of the document, so this runs again after every
 * call that could have changed what the tab is showing.
 */
export async function applyTabMarker(
  host: TabMarkerHost,
  tabId: string,
  owner: string
): Promise<void> {
  const unowned = !owner || owner === HUMAN_OWNER;
  const color = unowned ? UNOWNED_COLOR : agentColor(owner);
  const label = unowned ? `unclaimed · ${shortTabId(tabId)}` : `${owner} · ${shortTabId(tabId)}`;

  const payload = JSON.stringify({
    badgeId: TAB_BADGE_ID,
    faviconId: TAB_FAVICON_ID,
    color,
    label,
    href: faviconDataUri(color),
  });

  // Built as a string because the BiDi call passes no arguments - the values
  // are baked in at the call site instead.
  const fn = `() => {
    try {
      const cfg = ${payload};
      const doc = document;
      if (!doc || !doc.body) { return false; }

      let badge = doc.getElementById(cfg.badgeId);
      if (!badge) {
        badge = doc.createElement('div');
        badge.id = cfg.badgeId;
        // Marked every way a walker might look, so nothing downstream has to
        // recognise the id to know this is not page content.
        badge.setAttribute('aria-hidden', 'true');
        badge.setAttribute('data-ff-mcp', 'tab-badge');
        badge.setAttribute('role', 'presentation');
        doc.body.appendChild(badge);
      }
      badge.textContent = cfg.label;
      badge.style.cssText = [
        'position:fixed',
        'top:0',
        'right:0',
        'z-index:2147483647',
        'pointer-events:none',
        'user-select:none',
        'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
        'letter-spacing:.02em',
        'padding:2px 7px',
        'border-bottom-left-radius:6px',
        'color:#fff',
        'opacity:.92',
        'box-shadow:0 1px 3px rgba(0,0,0,.35)',
        'background:' + cfg.color,
      ].join(';');

      const head = doc.head;
      if (head) {
        // The page's own icons have to go, or Firefox keeps showing them.
        const existing = head.querySelectorAll('link[rel~="icon"],link[rel~="shortcut"]');
        for (const link of existing) {
          if (link.id !== cfg.faviconId) { link.remove(); }
        }
        let icon = doc.getElementById(cfg.faviconId);
        if (!icon) {
          icon = doc.createElement('link');
          icon.id = cfg.faviconId;
          icon.setAttribute('rel', 'icon');
          icon.setAttribute('type', 'image/svg+xml');
          head.appendChild(icon);
        }
        if (icon.getAttribute('href') !== cfg.href) {
          icon.setAttribute('href', cfg.href);
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }`;

  await host.evaluateInTab(tabId, fn);
}

/**
 * Paint several tabs at once, ignoring the ones that refuse.
 *
 * Runs in parallel because these are decoration: making a caller wait on a
 * serial walk of every tab would cost more than the marks are worth.
 */
export async function applyTabMarkers(
  host: TabMarkerHost,
  entries: Array<{ tabId: string; owner: string }>
): Promise<void> {
  await Promise.all(
    entries.map((entry) =>
      applyTabMarker(host, entry.tabId, entry.owner).catch(() => undefined)
    )
  );
}
