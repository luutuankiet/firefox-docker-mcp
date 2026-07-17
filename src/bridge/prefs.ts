/**
 * Structured Firefox preference helpers for the host-network bridge.
 *
 * Mirrors the chrome-context dance in tools/firefox-prefs.ts but returns TYPED
 * values (not formatted text) so the bridge can capture a baseline snapshot and
 * restore it verbatim on disconnect. Kept separate from firefox-prefs.ts on
 * purpose: the shipped prefs tools are already verified, so we add alongside
 * rather than refactor them.
 *
 * Both helpers enter the privileged ("chrome") context and restore the previous
 * content context in a finally block, exactly like the shipped prefs tools.
 */
import { generatePrefScript } from '../firefox/pref-utils.js';
import type { PrefValue } from '../cli.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Driver = any;

async function withChromeContext<T>(fn: (driver: Driver) => Promise<T>): Promise<T> {
  const { getFirefox } = await import('../index.js');
  const firefox = await getFirefox();

  const result = await firefox.sendBiDiCommand('browsingContext.getTree', {
    'moz:scope': 'chrome',
  });
  const contexts = (result && result.contexts) || [];
  const chromeContext = contexts[0];
  if (!chromeContext) {
    throw new Error(
      'No privileged contexts available. Ensure MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 is set and the server runs with --enable-privileged-context.'
    );
  }

  const driver = firefox.getDriver();
  const chromeContextId = chromeContext.context;
  const originalContextId = firefox.getCurrentContextId();

  try {
    await driver.switchTo().window(chromeContextId);
    await driver.setContext('chrome');
    return await fn(driver);
  } finally {
    // ALWAYS return marionette to content mode. The shipped prefs tool restores
    // only when a prior content context id was tracked; that leaves the driver
    // stuck in chrome mode when getCurrentContextId() is null (e.g. right after
    // a fresh reconnect), which breaks every subsequent content-context tool.
    try {
      await driver.setContext('content');
      if (originalContextId && originalContextId !== chromeContextId) {
        await driver.switchTo().window(originalContextId);
      }
    } catch {
      // ignore errors restoring context
    }
  }
}

/** Set each preference via Services.prefs in the chrome context. */
export async function applyProxyPrefs(prefs: Record<string, PrefValue>): Promise<void> {
  await withChromeContext(async (driver) => {
    for (const [name, value] of Object.entries(prefs)) {
      const script = generatePrefScript(name, value);
      await driver.executeScript(script);
    }
  });
}

/** Read each preference; value is null when the pref is unset. */
export async function readProxyPrefs(names: string[]): Promise<Record<string, PrefValue | null>> {
  return withChromeContext(async (driver) => {
    const out: Record<string, PrefValue | null> = {};
    for (const name of names) {
      const key = JSON.stringify(name);
      const script = `
        (function() {
          const t = Services.prefs.getPrefType(${key});
          if (t === Services.prefs.PREF_INVALID) return { exists: false };
          if (t === Services.prefs.PREF_BOOL) return { exists: true, value: Services.prefs.getBoolPref(${key}) };
          if (t === Services.prefs.PREF_INT) return { exists: true, value: Services.prefs.getIntPref(${key}) };
          return { exists: true, value: Services.prefs.getStringPref(${key}) };
        })()
      `;
      const r = (await driver.executeScript(`return ${script}`)) as {
        exists: boolean;
        value?: PrefValue;
      };
      out[name] = r && r.exists && r.value !== undefined ? r.value : null;
    }
    return out;
  });
}
