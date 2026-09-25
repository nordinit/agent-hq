import * as https from 'https';

/**
 * TLS options for a WebSocket to an OpenClaw gateway, and only for that socket.
 *
 * The local gateway serves a self-signed certificate when its TLS is enabled, so its sockets
 * skip certificate verification. That exemption used to be taken by setting
 * NODE_TLS_REJECT_UNAUTHORIZED=0 before a gateway call, which switched verification off for
 * every later HTTPS request the process made — model providers, GitHub, Telegram. It now rides
 * on a dedicated agent passed to the gateway socket alone, and only where it cannot be abused:
 * a loopback gateway, which nothing off the host can impersonate. A remote gateway is verified
 * like any other peer unless the operator opts in with OPENCLAW_GATEWAY_TLS_INSECURE=1 (for a
 * self-signed gateway reached through host.docker.internal, say); NODE_EXTRA_CA_CERTS is the
 * better fix there.
 */
let insecureGatewayAgent: https.Agent | null = null;

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function gatewayTlsVerificationMayBeSkipped(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'https:') return false;
  if (isLoopbackHostname(parsed.hostname)) return true;
  return process.env.OPENCLAW_GATEWAY_TLS_INSECURE === '1';
}

export function openClawGatewayWsOptions(url: string): { agent?: https.Agent } {
  if (!gatewayTlsVerificationMayBeSkipped(url)) return {};
  insecureGatewayAgent ??= new https.Agent({ rejectUnauthorized: false });
  return { agent: insecureGatewayAgent };
}
