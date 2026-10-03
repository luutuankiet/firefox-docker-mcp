# Soft tenancy, with writes to a guessed tab refused

Agents sharing the browser get an identity and claim tabs, but are never isolated: every
agent can see and act on every tab, like processes on a shared machine, and the person's own
tab is never blocked. The one hard rule is that a write whose target tab was only inferred
from focus is **refused** rather than warned about.

## Considered options

- **Hard isolation per agent** (separate windows or profiles). Rejected: it breaks the point
  of a shared browser, where the person and the agents look at the same pages.
- **A warning on fallback writes** (shipped first). Failed in practice: two concurrent agents
  drove one tab into each other's work for minutes, because an agent with task momentum reads
  a warning on a successful result as noise.

## Consequences

Refusals must be complete in text, because one widely used client drops images from error
results. Claims are kept in memory, so a server restart drops them.
