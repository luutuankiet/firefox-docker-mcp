/**
 * Page/Tab/Window management
 */

import { WebDriver } from 'selenium-webdriver';
import { log } from '../utils/logger.js';

export class PageManagement {
  constructor(
    private driver: WebDriver,
    private getCurrentContextId: () => string | null,
    private setCurrentContextId: (id: string) => void,
    private sendBiDi: (method: string, params?: Record<string, any>) => Promise<any> = async () => {
      throw new Error('BiDi unavailable');
    }
  ) {}

  /**
   * Navigate to URL
   */
  async navigate(url: string): Promise<void> {
    await this.driver.get(url);
    log(`Navigated to: ${url}`);
  }

  /**
   * Navigate back in history
   */
  async navigateBack(): Promise<void> {
    await this.driver.navigate().back();
  }

  /**
   * Navigate forward in history
   */
  async navigateForward(): Promise<void> {
    await this.driver.navigate().forward();
  }

  /**
   * Set viewport size
   */
  async setViewportSize(width: number, height: number): Promise<void> {
    await this.driver.manage().window().setRect({ width, height });
  }

  /**
   * Accept dialog (alert/confirm/prompt)
   * @param promptText - Optional text to enter in prompt dialog
   */
  async acceptDialog(promptText?: string): Promise<void> {
    try {
      const alert = await this.driver.switchTo().alert();
      if (promptText !== undefined) {
        await alert.sendKeys(promptText);
      }
      await alert.accept();
    } catch (error) {
      throw new Error(
        `Failed to accept dialog: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Dismiss dialog (alert/confirm/prompt)
   */
  async dismissDialog(): Promise<void> {
    try {
      const alert = await this.driver.switchTo().alert();
      await alert.dismiss();
    } catch (error) {
      throw new Error(
        `Failed to dismiss dialog: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private cachedTabs: Array<{ actor: string; title: string; url: string }> = [];
  private cachedSelectedIdx: number = 0;

  /**
   * Get all tabs (window handles)
   */
  getTabs(): Array<{ actor: string; title: string; url: string }> {
    return this.cachedTabs;
  }

  /**
   * Get selected tab index
   */
  getSelectedTabIdx(): number {
    return this.cachedSelectedIdx;
  }

  /**
   * Refresh tabs metadata - fetches all window handles and their URLs/titles
   */
  async refreshTabs(): Promise<void> {
    try {
      if (await this.refreshTabsWithoutSwitching()) {
        return;
      }

      const handles = await this.driver.getAllWindowHandles();
      const currentHandle = await this.driver.getWindowHandle();

      this.cachedTabs = [];
      this.cachedSelectedIdx = 0;

      for (let i = 0; i < handles.length; i++) {
        const handle = handles[i]!;

        // Switch to window to get its URL and title
        await this.driver.switchTo().window(handle);
        const url = await this.driver.getCurrentUrl();
        const title = await this.driver.getTitle();

        this.cachedTabs.push({
          actor: handle,
          title: title || 'Untitled',
          url: url || 'about:blank',
        });

        // Track which tab is selected
        if (handle === currentHandle) {
          this.cachedSelectedIdx = i;
        }
      }

      // Switch back to the original window
      await this.driver.switchTo().window(currentHandle);
    } catch (error) {
      log(`Error refreshing tabs: ${error instanceof Error ? error.message : String(error)}`);
      // Fallback to single tab
      const currentId = this.getCurrentContextId();
      this.cachedTabs = [
        {
          actor: currentId || '',
          title: 'Current Tab',
          url: '',
        },
      ];
      this.cachedSelectedIdx = 0;
    }
  }

  /**
   * Read every tab's URL and title without changing which one is on screen.
   *
   * The switch-based path below raises each tab in turn to read its metadata,
   * so merely listing tabs yanks the view of anyone watching over VNC. The tab
   * tree reports all contexts in a single round-trip, and titles come from a
   * per-context script evaluation that also leaves focus alone.
   *
   * Returns false when this cannot be done, so the caller falls back.
   */
  private async refreshTabsWithoutSwitching(): Promise<boolean> {
    let tree: any;
    try {
      tree = await this.sendBiDi('browsingContext.getTree', {});
    } catch {
      return false;
    }

    const contexts: any[] = Array.isArray(tree?.contexts) ? tree.contexts : [];
    // Nested contexts are iframes; only top-level ones are tabs.
    const tabs = contexts.filter((c) => c && typeof c.context === 'string' && !c.parent);
    if (tabs.length === 0) {
      return false;
    }

    // Window handles and context ids are the same value here, so ordering by
    // handle keeps indices consistent with what the classic API would report.
    let handles: string[] = [];
    try {
      handles = await this.driver.getAllWindowHandles();
    } catch {
      handles = [];
    }
    const rank = new Map(handles.map((handle, i) => [handle, i]));
    tabs.sort(
      (a, b) => (rank.get(a.context) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.context) ?? Number.MAX_SAFE_INTEGER)
    );

    const titles = await Promise.all(
      tabs.map(async (c) => {
        try {
          const res = await this.sendBiDi('script.evaluate', {
            expression: 'document.title',
            target: { context: c.context },
            awaitPromise: false,
          });
          const value = res?.result?.value;
          return typeof value === 'string' ? value : '';
        } catch {
          // A tab still loading, or one showing a privileged page, simply has no
          // title to report yet - that is not a reason to fail the whole list.
          return '';
        }
      })
    );

    let currentHandle: string | null = null;
    try {
      currentHandle = await this.driver.getWindowHandle();
    } catch {
      currentHandle = this.getCurrentContextId();
    }

    this.cachedTabs = tabs.map((c, i) => ({
      actor: String(c.context),
      title: titles[i] || 'Untitled',
      url: typeof c.url === 'string' && c.url ? c.url : 'about:blank',
    }));

    const selected = this.cachedTabs.findIndex((t) => t.actor === currentHandle);
    this.cachedSelectedIdx = selected >= 0 ? selected : 0;
    return true;
  }

  /**
   * Position of a tab in the current cache, or -1 when it is gone.
   *
   * Indices shift whenever any caller opens or closes a tab, so they are a
   * display detail; the handle is what callers should hold onto.
   */
  indexOfTab(tabId: string): number {
    return this.cachedTabs.findIndex((tab) => tab.actor === tabId);
  }

  /**
   * Focus a tab by its stable id.
   */
  async selectTabById(tabId: string): Promise<void> {
    await this.driver.switchTo().window(tabId);
    this.setCurrentContextId(tabId);
    const idx = this.indexOfTab(tabId);
    if (idx >= 0) {
      this.cachedSelectedIdx = idx;
    }
  }

  /**
   * Close a tab by its stable id, leaving focus on a surviving tab.
   */
  async closeTabById(tabId: string): Promise<void> {
    const handles = await this.driver.getAllWindowHandles();
    if (!handles.includes(tabId)) {
      throw new Error(`Tab ${tabId} not found`);
    }
    await this.driver.switchTo().window(tabId);
    await this.driver.close();
    const remaining = await this.driver.getAllWindowHandles();
    if (remaining.length > 0) {
      await this.driver.switchTo().window(remaining[0]!);
      this.setCurrentContextId(remaining[0]!);
    }
  }

  /**
   * Open a tab and report the stable id its opener should hold onto.
   */
  async createNewPageWithId(url: string): Promise<{ tabId: string; index: number }> {
    await this.driver.switchTo().newWindow('tab');
    const handles = await this.driver.getAllWindowHandles();
    const newIdx = handles.length - 1;
    const tabId = handles[newIdx]!;
    this.setCurrentContextId(tabId);
    this.cachedSelectedIdx = newIdx;
    await this.driver.get(url);
    return { tabId, index: newIdx };
  }

  /**
   * Close a tab without first bringing it to the front.
   *
   * The classic path raises a tab in order to close it and then lands on
   * whichever tab comes first, so tidying up after itself moved the view twice:
   * once to a page about to disappear, once to a stranger's.
   *
   * The tab the driver is attached to still has to go the old way - closing it
   * out from under the session would leave the driver pointing at nothing.
   */
  async closeTabInBackground(tabId: string): Promise<void> {
    let attached: string | null;
    try {
      attached = await this.driver.getWindowHandle();
    } catch {
      attached = this.getCurrentContextId();
    }

    if (attached === tabId) {
      await this.closeTabById(tabId);
      return;
    }

    await this.sendBiDi('browsingContext.close', { context: tabId });
    await this.refreshTabs();
  }

  /**
   * Open a tab without bringing it to the front.
   *
   * Opening and focusing were always the same act for a new tab, which is what
   * made this the last call able to pull the view away from a person mid-task.
   * Asking for the tab in the background separates the two.
   *
   * Throws when the browser cannot open tabs this way, so the caller can fall
   * back to the classic path rather than refuse to open anything at all.
   */
  async createNewPageInBackground(url: string): Promise<{ tabId: string; index: number }> {
    const created = await this.sendBiDi('browsingContext.create', {
      type: 'tab',
      background: true,
    });

    const tabId = created?.context;
    if (typeof tabId !== 'string' || !tabId) {
      throw new Error('BiDi unavailable: the browser reported no new tab');
    }

    await this.sendBiDi('browsingContext.navigate', {
      context: tabId,
      url,
      wait: 'complete',
    });

    // Indices are read from the cache, and nothing here selected the new tab,
    // so refreshing leaves the selection where the person at the browser had it.
    await this.refreshTabs();
    return { tabId, index: this.indexOfTab(tabId) };
  }

  /**
   * Select tab by index
   */
  async selectTab(index: number): Promise<void> {
    const handles = await this.driver.getAllWindowHandles();
    if (index >= 0 && index < handles.length) {
      await this.driver.switchTo().window(handles[index]!);
      this.setCurrentContextId(handles[index]!);
      this.cachedSelectedIdx = index;
    }
  }

  /**
   * Create new page (tab)
   */
  async createNewPage(url: string): Promise<number> {
    const { index } = await this.createNewPageWithId(url);
    return index;
  }

  /**
   * Close tab by index
   */
  async closeTab(index: number): Promise<void> {
    const handles = await this.driver.getAllWindowHandles();
    if (index >= 0 && index < handles.length) {
      await this.driver.switchTo().window(handles[index]!);
      await this.driver.close();
      const remaining = await this.driver.getAllWindowHandles();
      if (remaining.length > 0) {
        await this.driver.switchTo().window(remaining[0]!);
        this.setCurrentContextId(remaining[0]!);
      }
    }
  }
}
