/**
 * A text sketch of what a tab is showing.
 *
 * Written for refusals. Telling an agent "that tab is not yours" without saying
 * what is on it just moves the work: the agent calls back to look, and the
 * refusal has cost a round trip instead of saving one. A screenshot answers it
 * best, but image blocks do not survive every client on an error response, so
 * the same answer is carried in text as well - text always lands.
 */

export interface TabDigest {
  title: string;
  text: string;
  links: number;
  controls: number;
}

export interface TabDigestHost {
  evaluateInTab(tabId: string, functionDeclaration: string): Promise<unknown>;
}

/** How much page text to quote. Enough to recognise a page, short of a dump. */
const MAX_TEXT = 600;

/**
 * Read a tab without acting on it. Returns null rather than throwing: a page
 * that cannot be read makes for a thinner refusal, never a failed one.
 */
export async function digestTab(
  host: TabDigestHost,
  tabId: string,
  maxText: number = MAX_TEXT
): Promise<TabDigest | null> {
  const fn = `() => {
    try {
      var body = document.body;
      var clone = body ? body.cloneNode(true) : null;
      if (clone) {
        var junk = clone.querySelectorAll('script,style,noscript,svg,[data-ff-mcp]');
        for (var i = 0; i < junk.length; i++) { junk[i].remove(); }
      }
      var text = clone ? (clone.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      return JSON.stringify({
        title: (document.title || '').slice(0, 200),
        text: text.slice(0, ${maxText}),
        links: document.querySelectorAll('a[href]').length,
        controls: document.querySelectorAll('input,textarea,select,button').length
      });
    } catch (e) {
      return null;
    }
  }`;

  try {
    const raw = await host.evaluateInTab(tabId, fn);
    if (typeof raw !== 'string') {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<TabDigest>;
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      text: typeof parsed.text === 'string' ? parsed.text : '',
      links: typeof parsed.links === 'number' ? parsed.links : 0,
      controls: typeof parsed.controls === 'number' ? parsed.controls : 0,
    };
  } catch {
    return null;
  }
}
