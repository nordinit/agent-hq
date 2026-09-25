import { gatewayTlsVerificationMayBeSkipped, isLoopbackHostname, openClawGatewayWsOptions } from './openclawGatewayWs';

describe('OpenClaw gateway TLS options', () => {
  const originalInsecure = process.env.OPENCLAW_GATEWAY_TLS_INSECURE;
  const originalReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  afterEach(() => {
    if (originalInsecure === undefined) delete process.env.OPENCLAW_GATEWAY_TLS_INSECURE;
    else process.env.OPENCLAW_GATEWAY_TLS_INSECURE = originalInsecure;
  });

  it('skips certificate verification only for a loopback gateway', () => {
    for (const url of ['wss://127.0.0.1:18789', 'wss://localhost:18789', 'wss://[::1]:18789', 'https://127.0.0.2:18789']) {
      const options = openClawGatewayWsOptions(url);
      expect({ url, rejectUnauthorized: options.agent?.options.rejectUnauthorized }).toEqual({ url, rejectUnauthorized: false });
    }
  });

  it('verifies a remote gateway and never touches plain sockets', () => {
    expect(openClawGatewayWsOptions('wss://gateway.example.com')).toEqual({});
    expect(openClawGatewayWsOptions('wss://host.docker.internal:18789')).toEqual({});
    expect(openClawGatewayWsOptions('wss://127.0.0.1.attacker.example')).toEqual({});
    expect(openClawGatewayWsOptions('ws://127.0.0.1:18789')).toEqual({});
    expect(openClawGatewayWsOptions('not a url')).toEqual({});
  });

  it('lets the operator opt a self-signed remote gateway out of verification', () => {
    process.env.OPENCLAW_GATEWAY_TLS_INSECURE = '1';
    expect(gatewayTlsVerificationMayBeSkipped('wss://host.docker.internal:18789')).toBe(true);
    expect(openClawGatewayWsOptions('wss://host.docker.internal:18789').agent).toBeDefined();
  });

  it('leaves process-wide certificate verification alone', () => {
    openClawGatewayWsOptions('wss://127.0.0.1:18789');
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(originalReject);
  });

  it('recognises loopback hostnames only', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('LOCALHOST')).toBe(true);
    expect(isLoopbackHostname('10.0.0.1')).toBe(false);
    expect(isLoopbackHostname('localhost.example.com')).toBe(false);
  });
});
