---
symptom: "the refusal or error reply has no screenshot in Claude Code even though the server attached one"
area: tool call pipeline
verified: 2026-10-03
---

# A refusal's screenshot never arrives

**Symptom.** A tool call is refused (for example a write to a tab that was only resolved by
focus fallback). The server attaches a screenshot to the refusal, but Claude Code shows only
the text. The same screenshot attached to a successful reply renders fine.

**Mechanism.** Claude Code discards non-text content blocks when a tool result has
`isError: true`, and concatenates the remaining text. The server is not dropping anything.
This was established with a wire bisect of one refusal through every hop: the server, an
HTTP MCP proxy and a stdio proxy shim all forwarded `text + image + text` with the error
flag intact; only the client dropped the image. A control call (`new_page`,
`isError: false`, one image) rendered end to end.

**What the repo does about it.** Every refusal carries a complete text description of the
tab — title, URL, owner, 600 characters of visible text, link and form-control counts —
from `digestTab()` in `src/firefox/tab-digest.ts`. That text is load-bearing, not
decoration: it is the only channel that survives this client. The screenshot is still
attached for clients that follow the spec.

**Deliberate.** Refusals stay `isError: true`. Downgrading them to a success to win the image
back would turn the refusal into an ignorable warning, which is exactly the failure the
refusal was introduced to end: agents with task momentum read a warning attached to a
successful result as noise.

**Verify.** Call a mutating tool with no `tab` while not holding one, from Claude Code and
from any other MCP client; compare what renders.

**The general rule.** Any error payload that matters must be complete in text. Never let an
image be the only carrier of information on an error path.
