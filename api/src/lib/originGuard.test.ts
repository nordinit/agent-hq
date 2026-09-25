import express from 'express';
import cors from 'cors';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  corsOptionsDelegate,
  isOriginAllowed,
  isWebSocketOriginAllowed,
  parseAllowedOrigins,
  rejectCrossOriginRequests,
} from './originGuard';

describe('originGuard', () => {
  const none = new Set<string>();

  it('parses and normalizes the allowlist, skipping invalid entries', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const allowed = parseAllowedOrigins(' https://hq.example.com/path , not a url,http://localhost:3500 ');
    expect([...allowed]).toEqual(['https://hq.example.com', 'http://localhost:3500']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('allows requests without an Origin header (servers, agents, the UI proxy)', () => {
    expect(isOriginAllowed(undefined, { host: '127.0.0.1:3501' }, none)).toBe(true);
  });

  it('allows same-origin and allowlisted origins, and rejects everything else', () => {
    expect(isOriginAllowed('http://127.0.0.1:3501', { host: '127.0.0.1:3501' }, none)).toBe(true);
    expect(isOriginAllowed('https://evil.example', { host: '127.0.0.1:3501' }, none)).toBe(false);
    expect(isOriginAllowed('http://localhost:3500', { host: '127.0.0.1:3501' }, none)).toBe(false);
    expect(isOriginAllowed('http://localhost:3500', { host: '127.0.0.1:3501' }, new Set(['http://localhost:3500']))).toBe(true);
    expect(isOriginAllowed('null', { host: '127.0.0.1:3501' }, none)).toBe(false);
    expect(isOriginAllowed('file:///tmp/x.html', { host: '127.0.0.1:3501' }, none)).toBe(false);
  });

  it('lets the UI open the chat socket on the API port of the same host', () => {
    expect(isWebSocketOriginAllowed('http://localhost:3500', { host: 'localhost:3501' }, none)).toBe(true);
    expect(isWebSocketOriginAllowed('https://evil.example', { host: 'localhost:3501' }, none)).toBe(false);
    expect(isWebSocketOriginAllowed(undefined, { host: 'localhost:3501' }, none)).toBe(true);
  });

  describe('as middleware', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const allowed = new Set(['https://ops.example.com']);
      const app = express();
      app.use(cors(corsOptionsDelegate(allowed)));
      app.use('/api/v1', rejectCrossOriginRequests(allowed));
      app.post('/api/v1/tools', (_req, res) => { res.json({ ran: true }); });
      app.get('/.well-known/oauth-authorization-server', (_req, res) => { res.json({ issuer: 'x' }); });
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('refuses a cross-site POST before it reaches the route', async () => {
      const res = await fetch(`${baseUrl}/api/v1/tools`, { method: 'POST', headers: { origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(await res.json()).toMatchObject({ code: 'cross_origin_forbidden' });
    });

    it('serves requests without an Origin and from allowlisted origins', async () => {
      expect((await fetch(`${baseUrl}/api/v1/tools`, { method: 'POST' })).status).toBe(200);
      const allowed = await fetch(`${baseUrl}/api/v1/tools`, { method: 'POST', headers: { origin: 'https://ops.example.com' } });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://ops.example.com');
    });

    it('does not grant CORS to other origins on preflight', async () => {
      const res = await fetch(`${baseUrl}/api/v1/tools`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('keeps open CORS on routes outside the operator API', async () => {
      const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { headers: { origin: 'https://claude.ai' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });
});
