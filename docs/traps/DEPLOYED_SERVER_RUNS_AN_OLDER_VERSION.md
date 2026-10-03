---
symptom: "the prod image tag says the new version but the server still behaves like the old one"
area: docker stacks and releases
verified: 2026-10-03
---

# The deployed server runs an older version than its image tag

**Symptom.** You built and started a production server image tagged with the new version.
A smoke call works. But the new behaviour is missing, or the startup banner reports an older
version.

**Mechanism.** The production version lives in two places in `docker/docker-compose.yaml`,
both reading `MCP_VERSION`:

```yaml
      args:
        MCP_VERSION: ${MCP_VERSION:-0.10.2}    # what Dockerfile.prod npm-installs
    image: firefox-docker-mcp:${MCP_VERSION:-0.10.2}   # what the image is called
```

The image tag is a label the builder chose; the build argument is what actually gets
installed. If they disagree, you get an image labelled new containing old code — and a smoke
test of a tool that did not change passes identically. This happened once: an image labelled
`0.10.0` contained package `0.9.0`, and was reported as deployed.

Separately, `SERVER_VERSION` in `src/config/constants.ts` is what the banner, the
`/health` endpoint and the MCP handshake report. It once sat at `0.7.0` through three
releases because nothing read it back.

**What prevents it now.** `npm version` runs `scripts/sync-release-version.mjs`, which
rewrites every `${MCP_VERSION:-…}` default in the prod compose file and `SERVER_VERSION`,
and the `version` script stages both, so the release commit and tag contain them. The trap
is still live for anyone who edits one default by hand, or sets the image tag some other way.

**Verify a deploy by what runs, never by the tag:**

```
docker exec firefox-mcp npm ls -g --depth=0
```

**The general rule.** A version string that nothing reads back will drift, and the moment it
matters is the moment it cannot be trusted. Check the installed package, not the label.
