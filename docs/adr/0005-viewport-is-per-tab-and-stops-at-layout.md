# Viewport emulation is per tab and stops at layout

`set_viewport_size` resizes one tab via `browsingContext.setViewport`; resizing the OS window
reshaped every other agent's page and the person's VNC view. Emulation deliberately stops at
layout: a 390×844 tab still reports a desktop user agent and `pointer: coarse` is false,
because Firefox's user-agent override is a browser-wide pref, and honouring it per tab would
bring back exactly the fleet-wide contamination this change removed.

## Consequences

Sites that adapt through CSS media queries render correctly; sites that sniff the user agent
or gate on touch serve their desktop version. `scope: "window"` keeps the old window resize
as an explicit choice. Device pixel ratio is opt-in, not part of a preset, because it changes
no layout and multiplies captured pixels.
