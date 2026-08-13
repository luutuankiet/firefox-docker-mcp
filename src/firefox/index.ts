/**
 * Firefox Client - Public facade for modular Firefox automation
 */

import type { FirefoxLaunchOptions, ConsoleMessage } from './types.js';
import { WebElement } from 'selenium-webdriver';
import { FirefoxCore } from './core.js';
import { logDebug } from '../utils/logger.js';
import { ConsoleEvents, NetworkEvents } from './events/index.js';
import { ContextTree } from './context-tree.js';
import { DomInteractions } from './dom.js';
import { PageManagement } from './pages.js';
import { SnapshotManager, type Snapshot, type SnapshotOptions } from './snapshot/index.js';
import {
  navigateInContext,
  callFunctionInContext,
  screenshotContext,
  setViewportInContext,
  waitForContextReady,
} from './bidi-ops.js';
import {
  findElementRef,
  clickElementRef,
  hoverElementRef,
  fillElementRef,
  dragElementRefs,
  prepareFileInputRef,
  setFilesOnElementRef,
  screenshotElementRef,
  settleAfterAction,
} from './bidi-input.js';

/**
 * Main Firefox Client facade
 * Delegates to modular components for clean separation of concerns
 */
export class FirefoxClient {
  private core: FirefoxCore;
  private consoleEvents: ConsoleEvents | null = null;
  private networkEvents: NetworkEvents | null = null;
  private contextTree: ContextTree | null = null;
  private dom: DomInteractions | null = null;
  private pages: PageManagement | null = null;
  private snapshot: SnapshotManager | null = null;

  constructor(options: FirefoxLaunchOptions) {
    this.core = new FirefoxCore(options);
  }

  /**
   * Connect and initialize all modules
   */
  async connect(): Promise<void> {
    await this.core.connect();

    const driver = this.core.getDriver();

    // Initialize snapshot manager first
    this.snapshot = new SnapshotManager(driver, this.bidi);

    // Create centralized navigation handler for lifecycle hooks
    const onNavigate = (contextId?: string) => {
      // A page that navigated has replaced the elements its snapshot named, so
      // those uids are gone. Every other tab's uids are still good, and clearing
      // them too is what used to break agents that were never on this page.
      if (this.snapshot) {
        this.snapshot.clear(contextId);
      }
    };

    // Initialize event modules with lifecycle hooks.
    // BiDi (console/network events) is available in both launch and connect-existing
    // modes, provided Firefox has its Remote Agent running. If webSocketUrl is absent
    // from the session capabilities (e.g. Firefox started without --remote-debugging-port),
    // the subscribe calls below will fail gracefully and the modules will be disabled.
    const hasBidi = 'getBidi' in driver && typeof driver.getBidi === 'function';

    if (hasBidi) {
      // Cast to any for BiDi-specific APIs that only exist on selenium WebDriver
      this.consoleEvents = new ConsoleEvents(driver as any, {
        onNavigate,
        autoClearOnNavigate: false,
      });

      this.networkEvents = new NetworkEvents(driver as any, {
        onNavigate,
        autoClearOnNavigate: false,
      });

      // Records which tab each browsing context sits under, so an entry logged
      // by an iframe or by a popup can be attributed to the tab responsible for
      // it rather than discarded for having a different context id.
      this.contextTree = new ContextTree(driver as any, (method, params = {}) =>
        this.core.sendBiDiCommand(method, params)
      );
    }

    // Initialize DOM with UID resolver callback
    this.dom = new DomInteractions(driver, (uid: string) =>
      this.snapshot!.resolveUidToElement(uid)
    );

    this.pages = new PageManagement(
      driver,
      () => this.core.getCurrentContextId(),
      (id: string) => this.core.setCurrentContextId(id),
      (method: string, params: Record<string, any> = {}) =>
        this.core.sendBiDiCommand(method, params)
    );

    // Subscribe to console and network events for ALL contexts (not just current).
    // Failures here are non-fatal: Firefox may not have the Remote Agent / BiDi
    // enabled (e.g. launched with --marionette only, no --remote-debugging-port),
    // in which case webSocketUrl is absent from capabilities and getBidi() throws.
    // We degrade gracefully so all non-BiDi tools still work.
    if (this.consoleEvents) {
      try {
        await this.consoleEvents.subscribe(undefined);
      } catch {
        logDebug('Console events unavailable (BiDi not supported by this Firefox session)');
        this.consoleEvents = null;
      }
    }
    if (this.networkEvents) {
      try {
        await this.networkEvents.subscribe(undefined);
      } catch {
        logDebug('Network events unavailable (BiDi not supported by this Firefox session)');
        this.networkEvents = null;
      }
    }
    if (this.contextTree) {
      try {
        await this.contextTree.subscribe();
      } catch {
        logDebug('Context tree unavailable (BiDi not supported by this Firefox session)');
        this.contextTree = null;
      }
    }
  }

  /**
   * Topology of the browser's contexts, for callers that need to know which tab
   * a logged entry belongs to. Null when BiDi is unavailable.
   */
  getContextTree(): ContextTree | null {
    return this.contextTree;
  }

  // ============================================================================
  // DOM / Evaluate
  // ============================================================================

  async evaluate(script: string): Promise<unknown> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.evaluate(script);
  }

  async getContent(): Promise<string> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.getContent();
  }

  async clickBySelector(selector: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.clickBySelector(selector);
  }

  async hoverBySelector(selector: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.hoverBySelector(selector);
  }

  async fillBySelector(selector: string, text: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.fillBySelector(selector, text);
  }

  async dragAndDropBySelectors(sourceSelector: string, targetSelector: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.dragAndDropBySelectors(sourceSelector, targetSelector);
  }

  async uploadFileBySelector(selector: string, filePath: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.uploadFileBySelector(selector, filePath);
  }

  // UID-based input methods

  async clickByUid(uid: string, dblClick = false): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.clickByUid(uid, dblClick);
  }

  async hoverByUid(uid: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.hoverByUid(uid);
  }

  async fillByUid(uid: string, value: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.fillByUid(uid, value);
  }

  async dragByUidToUid(fromUid: string, toUid: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.dragByUidToUid(fromUid, toUid);
  }

  async fillFormByUid(elements: Array<{ uid: string; value: string }>): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.fillFormByUid(elements);
  }

  async uploadFileByUid(uid: string, filePath: string): Promise<void> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.uploadFileByUid(uid, filePath);
  }

  // ============================================================================
  // Console
  // ============================================================================

  async getConsoleMessages(): Promise<ConsoleMessage[]> {
    if (!this.consoleEvents) {
      throw new Error(
        'Console events not available (Firefox Remote Agent not running — start Firefox with --remote-debugging-port to enable BiDi)'
      );
    }
    return this.consoleEvents.getMessages();
  }

  clearConsoleMessages(shouldClear?: (message: ConsoleMessage) => boolean): number {
    if (!this.consoleEvents) {
      throw new Error(
        'Console events not available (Firefox Remote Agent not running — start Firefox with --remote-debugging-port to enable BiDi)'
      );
    }
    return this.consoleEvents.clearMessages(shouldClear);
  }

  // ============================================================================
  // Pages / Navigation
  // ============================================================================

  async navigate(url: string): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    await this.pages.navigate(url);
    // Clear snapshot on navigation (but NOT console - users can manually clear if needed)
    this.clearSnapshot(await this.focusedTabId());
  }

  // ============================================================================
  // Tab-targeted operations
  //
  // These name the tab they act on instead of acting on whichever tab is
  // focused, so concurrent callers stop fighting over the foreground and a
  // person watching the browser keeps their view. Each throws when the browser
  // cannot address tabs this way; callers fall back to the classic methods.
  // ============================================================================

  private bidi = (method: string, params: Record<string, any> = {}): Promise<any> =>
    this.core.sendBiDiCommand(method, params);

  /**
   * Which tab the browser is currently showing.
   *
   * The tracked id is authoritative once anything has selected a tab; asking
   * the driver covers the window between connecting and the first selection,
   * when nothing has recorded one yet.
   */
  private async focusedTabId(): Promise<string> {
    return this.core.getCurrentContextId() ?? (await this.core.getDriver().getWindowHandle());
  }

  async navigateInTab(tabId: string, url: string): Promise<void> {
    await navigateInContext(this.bidi, tabId, url);
    this.clearSnapshot(tabId);
  }

  async evaluateInTab(tabId: string, functionDeclaration: string): Promise<unknown> {
    return await callFunctionInContext(this.bidi, tabId, functionDeclaration);
  }

  async screenshotTab(tabId: string): Promise<string> {
    return await screenshotContext(this.bidi, tabId);
  }

  async waitForTabReady(tabId: string, timeoutMs: number): Promise<string | null> {
    return await waitForContextReady(this.bidi, tabId, timeoutMs);
  }

  /**
   * Turn a snapshot uid into a reference the browser can act on, in a named tab.
   *
   * The uid layer holds selectors in memory, so this costs one call into the
   * page and never consults the focused driver.
   */
  private async uidRefInTab(tabId: string, uid: string): Promise<string> {
    if (!this.snapshot) {
      throw new Error('Not connected');
    }
    const { css, xpath } = this.snapshot.resolveUidToLocators(uid);
    return await findElementRef(this.bidi, tabId, css, xpath);
  }

  async clickUidInTab(tabId: string, uid: string, dblClick = false): Promise<void> {
    const ref = await this.uidRefInTab(tabId, uid);
    await clickElementRef(this.bidi, tabId, ref, dblClick);
    await settleAfterAction();
  }

  async hoverUidInTab(tabId: string, uid: string): Promise<void> {
    const ref = await this.uidRefInTab(tabId, uid);
    await hoverElementRef(this.bidi, tabId, ref);
    await settleAfterAction();
  }

  async fillUidInTab(tabId: string, uid: string, value: string): Promise<void> {
    const ref = await this.uidRefInTab(tabId, uid);
    await fillElementRef(this.bidi, tabId, ref, value);
    await settleAfterAction();
  }

  async dragUidToUidInTab(tabId: string, fromUid: string, toUid: string): Promise<void> {
    const fromRef = await this.uidRefInTab(tabId, fromUid);
    const toRef = await this.uidRefInTab(tabId, toUid);
    await dragElementRefs(this.bidi, tabId, fromRef, toRef);
    await settleAfterAction();
  }

  async fillFormUidInTab(
    tabId: string,
    elements: Array<{ uid: string; value: string }>
  ): Promise<void> {
    // Sequential because each field can reveal or reshape the next one.
    for (const { uid, value } of elements) {
      await this.fillUidInTab(tabId, uid, value);
    }
  }

  async uploadFileUidInTab(tabId: string, uid: string, filePath: string): Promise<void> {
    const ref = await this.uidRefInTab(tabId, uid);
    await prepareFileInputRef(this.bidi, tabId, ref);
    await setFilesOnElementRef(this.bidi, tabId, ref, filePath);
    await settleAfterAction();
  }

  async screenshotUidInTab(tabId: string, uid: string): Promise<string> {
    const ref = await this.uidRefInTab(tabId, uid);
    return await screenshotElementRef(this.bidi, tabId, ref);
  }

  async navigateBack(): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.navigateBack();
  }

  async navigateForward(): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.navigateForward();
  }

  async setViewportSize(width: number, height: number): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.setViewportSize(width, height);
  }

  /**
   * Resize a single tab's content viewport. Throws when the browser has no
   * BiDi session, which is the caller's cue to fall back to the window.
   */
  async setTabViewport(
    tabId: string,
    viewport: { width: number; height: number } | null,
    devicePixelRatio?: number | null
  ): Promise<void> {
    return await setViewportInContext(this.bidi, tabId, viewport, devicePixelRatio);
  }

  async acceptDialog(promptText?: string): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.acceptDialog(promptText);
  }

  async dismissDialog(): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.dismissDialog();
  }

  getTabs(): Array<{ actor: string; title: string; url: string }> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return this.pages.getTabs();
  }

  getSelectedTabIdx(): number {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return this.pages.getSelectedTabIdx();
  }

  async refreshTabs(): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.refreshTabs();
  }

  async selectTab(index: number): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.selectTab(index);
  }

  async createNewPage(url: string): Promise<number> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.createNewPage(url);
  }

  async closeTab(index: number): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.closeTab(index);
  }

  indexOfTab(tabId: string): number {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return this.pages.indexOfTab(tabId);
  }

  async selectTabById(tabId: string): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.selectTabById(tabId);
  }

  async closeTabById(tabId: string): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.closeTabById(tabId);
  }

  async createNewPageWithId(url: string): Promise<{ tabId: string; index: number }> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.createNewPageWithId(url);
  }

  async createNewPageInBackground(url: string): Promise<{ tabId: string; index: number }> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    return await this.pages.createNewPageInBackground(url);
  }

  async closeTabInBackground(tabId: string): Promise<void> {
    if (!this.pages) {
      throw new Error('Not connected');
    }
    await this.pages.closeTabInBackground(tabId);
  }

  // ============================================================================
  // Network
  // ============================================================================

  async startNetworkMonitoring(): Promise<void> {
    if (!this.networkEvents) {
      throw new Error(
        'Network events not available (Firefox Remote Agent not running — start Firefox with --remote-debugging-port to enable BiDi)'
      );
    }
    this.networkEvents.startMonitoring();
  }

  async stopNetworkMonitoring(): Promise<void> {
    if (!this.networkEvents) {
      throw new Error(
        'Network events not available (Firefox Remote Agent not running — start Firefox with --remote-debugging-port to enable BiDi)'
      );
    }
    this.networkEvents.stopMonitoring();
  }

  async getNetworkRequests(): Promise<any[]> {
    if (!this.networkEvents) {
      throw new Error(
        'Network events not available (Firefox Remote Agent not running — start Firefox with --remote-debugging-port to enable BiDi)'
      );
    }
    return this.networkEvents.getRequests();
  }

  clearNetworkRequests(): void {
    if (!this.networkEvents) {
      throw new Error(
        'Network events not available (Firefox Remote Agent not running — start Firefox with --remote-debugging-port to enable BiDi)'
      );
    }
    this.networkEvents.clearRequests();
  }

  // ============================================================================
  // Snapshot
  // ============================================================================

  async takeSnapshot(options?: SnapshotOptions): Promise<Snapshot> {
    if (!this.snapshot) {
      throw new Error('Not connected');
    }
    return await this.snapshot.takeSnapshot(await this.focusedTabId(), options);
  }

  async takeSnapshotInTab(tabId: string, options?: SnapshotOptions): Promise<Snapshot> {
    if (!this.snapshot) {
      throw new Error('Not connected');
    }
    return await this.snapshot.takeSnapshotInTab(tabId, options);
  }

  resolveUidToSelector(uid: string): string {
    if (!this.snapshot) {
      throw new Error('Not connected');
    }
    return this.snapshot.resolveUidToSelector(uid);
  }

  async resolveUidToElement(uid: string): Promise<WebElement> {
    if (!this.snapshot) {
      throw new Error('Not connected');
    }
    return await this.snapshot.resolveUidToElement(uid);
  }

  clearSnapshot(tabId?: string): void {
    if (!this.snapshot) {
      throw new Error('Not connected');
    }
    this.snapshot.clear(tabId);
  }

  // ============================================================================
  // Screenshot
  // ============================================================================

  async takeScreenshotPage(): Promise<string> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.takeScreenshotPage();
  }

  async takeScreenshotByUid(uid: string): Promise<string> {
    if (!this.dom) {
      throw new Error('Not connected');
    }
    return await this.dom.takeScreenshotByUid(uid);
  }

  // ============================================================================
  // Internal / Advanced
  // ============================================================================

  /**
   * Send raw BiDi command (for advanced operations)
   * @internal
   */
  async sendBiDiCommand(method: string, params: Record<string, any> = {}): Promise<any> {
    return await this.core.sendBiDiCommand(method, params);
  }

  /**
   * Get WebDriver instance (for advanced operations)
   * @internal
   */
  getDriver(): any {
    return this.core.getDriver();
  }

  /**
   * Get current browsing context ID (for advanced operations)
   * @internal
   */
  getCurrentContextId(): string | null {
    return this.core.getCurrentContextId();
  }

  /**
   * Update current browsing context ID
   * @internal
   */
  setCurrentContextId(contextId: string): void {
    this.core.setCurrentContextId(contextId);
  }

  /**
   * Check if Firefox is still connected and responsive
   * Returns false if Firefox was closed or connection is broken
   */
  async isConnected(): Promise<boolean> {
    return await this.core.isConnected();
  }

  /**
   * Get log file path (if logging is enabled)
   */
  getLogFilePath(): string | undefined {
    return this.core.getLogFilePath();
  }

  /**
   * Get current launch options
   */
  getOptions(): FirefoxLaunchOptions {
    return this.core.getOptions();
  }

  /**
   * Reset all internal state (used when Firefox is detected as closed)
   */
  reset(): void {
    this.core.reset();
    this.consoleEvents = null;
    this.networkEvents = null;
    this.dom = null;
    this.pages = null;
    this.snapshot = null;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async close(): Promise<void> {
    await this.core.close();
  }
}

// Re-export types
export type { Snapshot } from './snapshot/index.js';

// Re-export for backward compatibility
export { FirefoxClient as FirefoxDevTools };
