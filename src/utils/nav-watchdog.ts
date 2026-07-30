/**
 * Bounds the commands that unload a document.
 *
 * Unbounded, a navigation blocked by a modal the driver cannot reach never
 * settles: the server stops answering, the proxy in front of it marks the
 * whole upstream dead, and the agent watches unrelated tools disappear with no
 * hint of the cause. Failing fast with a diagnostic keeps the rest of the
 * process usable and tells the caller how to recover.
 */

export const DEFAULT_NAV_TIMEOUT_MS = 20000;

let navTimeoutMs = DEFAULT_NAV_TIMEOUT_MS;

export function setNavTimeoutMs(value: number): void {
  navTimeoutMs = Number.isFinite(value) && value > 0 ? value : 0;
}

export function getNavTimeoutMs(): number {
  return navTimeoutMs;
}

export class NavigationStalledError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(
      `${operation} did not finish within ${timeoutMs}ms. The tab is most likely blocked ` +
        'by a modal the driver cannot reach - a "Leave page?" prompt is the usual cause. ' +
        'accept_dialog and dismiss_dialog cannot clear that one. Recover by selecting a ' +
        'different tab with select_page, then dropping the blocked tab with close_page.'
    );
    this.name = 'NavigationStalledError';
  }
}

/**
 * Race `run()` against the configured timeout. A timeout rejects with a
 * NavigationStalledError; the underlying command is left to settle on its own.
 */
export async function withNavigationWatchdog<T>(
  operation: string,
  timeoutMs: number,
  run: () => Promise<T>
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return await run();
  }

  const task = run();

  // The watchdog may reject first, leaving this promise's own rejection
  // unobserved. Claim it here so a late failure cannot crash the process.
  task.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new NavigationStalledError(operation, timeoutMs)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
