/**
 * Host-network bridge tools (v0.3.0) - requires --enable-bridge.
 *
 * connect_host_network: point the browser's SOCKS proxy at a local dumb-pipe
 * listener that tunnels over HyperDHT to a remote `firefox-bridge` running the
 * same shared secret. The browser's localhost becomes the remote host's
 * localhost. One bridge at a time.
 *
 * disconnect_host_network: tear down the tunnel and restore the proxy prefs
 * that were captured at connect time.
 */
import { successResponse, errorResponse } from '../utils/response-helpers.js';
import type { McpToolResponse } from '../types/common.js';
import type { PrefValue } from '../cli.js';
import { startBridgeClient, type BridgeClient } from '../bridge/client.js';
import { applyProxyPrefs, readProxyPrefs } from '../bridge/prefs.js';

const PROXY_PREFS = [
  'network.proxy.type',
  'network.proxy.socks',
  'network.proxy.socks_port',
  'network.proxy.socks_remote_dns',
  'network.proxy.allow_hijacking_localhost',
];

/** Build a concrete restore map from a captured baseline, filling unset keys
 * with Firefox's no-proxy defaults (type=5 = use system settings). */
function baselineToRestore(baseline: Record<string, PrefValue | null>): Record<string, PrefValue> {
  const restore: Record<string, PrefValue> = {};
  for (const key of PROXY_PREFS) {
    const v = baseline[key];
    if (v === null || v === undefined) {
      restore[key] =
        key === 'network.proxy.type'
          ? 5
          : key === 'network.proxy.socks'
            ? ''
            : key === 'network.proxy.socks_port'
              ? 0
              : false;
    } else {
      restore[key] = v;
    }
  }
  return restore;
}

interface ActiveBridge {
  client: BridgeClient;
  baseline: Record<string, PrefValue | null>;
  name: string | undefined;
}

let activeBridge: ActiveBridge | null = null;
// Synchronous guard: set before the first await so two concurrent connect calls
// cannot both pass the one-at-a-time check (TOCTOU).
let connecting = false;

export const connectHostNetworkTool = {
  name: 'connect_host_network',
  description:
    "Bridge the browser to a remote host's localhost via the firefox-bridge P2P tunnel. Points Firefox's SOCKS proxy at a local listener that tunnels to the remote bridge running the same shared secret, so the browser's localhost becomes the remote host's localhost. One bridge at a time. Requires --enable-bridge and --enable-privileged-context.",
  inputSchema: {
    type: 'object',
    properties: {
      secret: {
        type: 'string',
        description:
          'Shared secret; must match the `npx @luutuankiet/firefox-bridge --secret` process running on the remote host.',
      },
      name: {
        type: 'string',
        description:
          'Optional display name printed by the bridge (cosmetic; the secret alone establishes identity).',
      },
    },
    required: ['secret'],
  },
};

export async function handleConnectHostNetwork(args: unknown): Promise<McpToolResponse> {
  if (activeBridge || connecting) {
    return errorResponse(
      new Error(
        `A bridge is already active${activeBridge?.name ? ` (${activeBridge.name})` : ''}. Call disconnect_host_network first - one bridge at a time.`
      )
    );
  }
  connecting = true;
  try {
    const { secret, name } = (args ?? {}) as { secret?: string; name?: string };
    if (!secret || typeof secret !== 'string' || secret.length < 8) {
      throw new Error(
        'secret is required and must be at least 8 characters (it must match the remote bridge).'
      );
    }

    // Capture the baseline BEFORE flipping so disconnect restores it exactly.
    const baseline = await readProxyPrefs(PROXY_PREFS);

    // startBridgeClient probes reachability first; a wrong secret or an offline
    // remote throws here, before we touch any browser prefs.
    const client = await startBridgeClient({ secret });

    try {
      await applyProxyPrefs({
        'network.proxy.type': 1,
        'network.proxy.socks': client.socksHost,
        'network.proxy.socks_port': client.socksPort,
        'network.proxy.socks_remote_dns': true,
        'network.proxy.allow_hijacking_localhost': true,
      });
    } catch (err) {
      // A partial pref flip would leave the browser half-proxied to a dead
      // endpoint. Best-effort restore the captured baseline before bailing.
      try {
        await applyProxyPrefs(baselineToRestore(baseline));
      } catch {
        // ignore restore failure; original error is more important
      }
      await client.close();
      throw err;
    }

    activeBridge = { client, baseline, name };

    return successResponse(
      [
        `🌉 Bridge connected${name ? ` to ${name}` : ''}.`,
        `Browser SOCKS proxy -> 127.0.0.1:${client.socksPort} -> (P2P) -> remote host.`,
        "The browser's localhost is now the remote host's localhost. Navigate to http://localhost:<port> to reach the remote dev app.",
        'Call disconnect_host_network to tear it down and restore proxy settings.',
      ].join('\n')
    );
  } catch (error) {
    return errorResponse(error as Error);
  } finally {
    connecting = false;
  }
}

export const disconnectHostNetworkTool = {
  name: 'disconnect_host_network',
  description:
    'Tear down the active firefox-bridge tunnel and restore the browser proxy preferences captured at connect time.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export async function handleDisconnectHostNetwork(_args: unknown): Promise<McpToolResponse> {
  try {
    if (!activeBridge) {
      return successResponse('No active bridge. Nothing to disconnect.');
    }
    const { client, baseline, name } = activeBridge;

    // Restore prefs first so the browser stops routing through the closing tunnel.
    await applyProxyPrefs(baselineToRestore(baseline));

    await client.close();
    activeBridge = null;

    return successResponse(
      `🧹 Bridge disconnected${name ? ` (${name})` : ''}. Proxy settings restored.`
    );
  } catch (error) {
    return errorResponse(error as Error);
  }
}
