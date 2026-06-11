import express from 'express';
import type { Server } from 'http';
import { handleJsonRequestErrors } from './jsonRequestErrors';

describe('handleJsonRequestErrors', () => {
  let server: Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use(handleJsonRequestErrors);
    app.post('/json', (_req, res) => res.json({ ok: true }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((err) => err ? reject(err) : resolve());
    });
    server = null;
  });

  it('returns a structured malformed_json response for invalid request bodies', async () => {
    const response = await fetch(`${baseUrl}/json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken": ',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Malformed JSON request body',
      code: 'malformed_json',
      path: '/json',
    });
  });

  it('passes through non-parse 400 errors to later middleware', async () => {
    const req = { originalUrl: '/json', url: '/json' } as unknown as express.Request;
    const res = {} as express.Response;
    const next = jest.fn();
    const err = Object.assign(new Error('validation failed'), { status: 400 });

    handleJsonRequestErrors(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
