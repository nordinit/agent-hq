import type { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { probeGateway } from './gatewayHealth';

describe('probeGateway credentials', () => {
  let server: WebSocketServer;
  let connectFrames: Array<Record<string, any>>;
  let url: string;

  beforeEach(async () => {
    connectFrames = [];
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } }));
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, any>;
        connectFrames.push(frame);
        socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true }));
      });
    });
  });

  afterEach(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('presents only the credentials it is given, without the host device signature', async () => {
    const result = await probeGateway(url, { token: 'caller-supplied', signWithDeviceIdentity: false });

    expect(result).toMatchObject({ ok: true, state: 'ready' });
    expect(connectFrames).toHaveLength(1);
    expect(connectFrames[0].params.auth).toEqual({ token: 'caller-supplied' });
    expect(connectFrames[0].params).not.toHaveProperty('device');
  });

  it('presents an empty token rather than the stored one when the caller supplied none', async () => {
    const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = 'host-gateway-secret';
    try {
      await probeGateway(url, { token: '', signWithDeviceIdentity: false });
    } finally {
      if (originalToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
    }

    expect(JSON.stringify(connectFrames)).not.toContain('host-gateway-secret');
  });
});
