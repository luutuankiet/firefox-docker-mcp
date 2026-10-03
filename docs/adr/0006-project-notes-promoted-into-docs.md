# Project notes live in docs/, not in a private notes directory

Until this record, the project's working knowledge — architecture map, deploy facts,
failure modes and decision history — lived in a gitignored notes directory read at the start
of each agent session, about 300 KB in all. It was promoted into this `docs/` tree: five
architecture pages, three traps, two reference pages and the decision records before this
one. Open follow-ups became GitHub issues, and the notes directory was deleted.

## Considered options

Keeping the notes alongside `docs/` was rejected: two stores of truth is how the first one
rots, and the notes were invisible to anyone else who cloned the repository.

## Consequences

Most of the notes were discarded rather than promoted, by design: release narrative is
already in `releases/`, history is in `git log`, and host-specific commands and addresses
describe one machine rather than this repository. Several recorded bugs had already been
fixed in code and were dropped for that reason.
