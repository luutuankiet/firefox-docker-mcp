/**
 * Privileged ("chrome" scope) script execution.
 *
 * Services.prefs and the rest of the platform API are reachable only from
 * chrome scope, which the driver has to be switched into and back out of.
 *
 * Restoring content scope is unconditional on purpose. An earlier version
 * restored only when the session already had a remembered content context, so
 * a privileged call made before any tab had been selected left the driver
 * stranded in chrome scope, and every later content tool failed with
 * "Only supported in content context" until another privileged call happened
 * to run with a context worth returning to.
 */

import { log } from './logger.js';

interface ChromeScopeHost {
  sendBiDiCommand(method: string, params?: Record<string, any>): Promise<any>;
  getDriver(): any;
  getCurrentContextId(): string | null;
}

/**
 * Run `fn` with the driver switched into chrome scope, then always return the
 * driver to a usable content context.
 */
export async function runInChromeScope<T>(
  firefox: ChromeScopeHost,
  fn: (driver: any) => Promise<T>
): Promise<T> {
  const tree = await firefox.sendBiDiCommand('browsingContext.getTree', {
    'moz:scope': 'chrome',
  });

  const contexts = tree?.contexts ?? [];
  if (contexts.length === 0) {
    throw new Error(
      'No privileged contexts available. Ensure MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 is set.'
    );
  }

  const driver = firefox.getDriver();
  const chromeContextId = contexts[0].context;
  const originalContextId = firefox.getCurrentContextId();

  try {
    await driver.switchTo().window(chromeContextId);
    await driver.setContext('chrome');
    return await fn(driver);
  } finally {
    try {
      await driver.setContext('content');

      // Prefer the caller's tab. With no remembered context, any content tab
      // beats leaving the driver pointed at the chrome window.
      let target: string | null = originalContextId;
      if (!target || target === chromeContextId) {
        const handles: string[] = await driver.getAllWindowHandles();
        target = handles.find((handle) => handle !== chromeContextId) ?? null;
      }
      if (target) {
        await driver.switchTo().window(target);
      }
    } catch (error) {
      log(`Failed to restore content scope after a privileged call: ${error}`);
    }
  }
}
