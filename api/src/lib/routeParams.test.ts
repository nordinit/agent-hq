import express from 'express';
import { AddressInfo } from 'net';
import { describe, expect, it } from '@jest/globals';
import { parseIdParam, requireNumericId } from './routeParams';

/**
 * The bug this guards against is engine-specific and was invisible on SQLite.
 *
 * `GET /api/v1/workflows/types` matches a `/:id` route and hands the handler the string 'types'.
 * SQLite compared that to an INTEGER column, matched nothing, and the route returned a clean 404.
 * PostgreSQL rejects the cast — `invalid input syntax for type bigint: "types"` — so the same
 * request became a 500 carrying database text.
 */
async function get(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe('parseIdParam', () => {
  it('accepts only positive whole numbers', () => {
    expect(parseIdParam('1')).toBe(1);
    expect(parseIdParam('99977365')).toBe(99977365);
  });

  it('rejects the values that would otherwise reach the database', () => {
    // Each of these is a real hazard rather than a hypothetical: 'types' is the literal route
    // segment that collides with /:id, and the numeric-looking ones all survive Number() while
    // being invalid ids.
    expect(parseIdParam('types')).toBeNull();
    expect(parseIdParam('12abc')).toBeNull();
    expect(parseIdParam(' 12 ')).toBeNull();   // Number(' 12 ') === 12
    expect(parseIdParam('1e3')).toBeNull();    // Number('1e3') === 1000
    expect(parseIdParam('-1')).toBeNull();
    expect(parseIdParam('0')).toBeNull();
    expect(parseIdParam('1.5')).toBeNull();
    expect(parseIdParam('')).toBeNull();
    expect(parseIdParam(undefined)).toBeNull();
    // Beyond 2^53 an id can no longer round-trip through a JS number.
    expect(parseIdParam('9007199254740993')).toBeNull();
  });
});

describe('requireNumericId', () => {
  function buildApp(): express.Express {
    const app = express();
    const router = express.Router();
    router.param('id', requireNumericId);
    // Literal BEFORE the parameterised route, which is the only ordering that works in Express:
    // routes match in registration order, so a literal declared after /:id is unreachable
    // regardless of this guard.
    router.get('/types', (_req, res) => res.json({ literalRoute: true }));
    // Stands in for a handler that would query an INTEGER column with the raw param.
    router.get('/:id', (req, res) => res.json({ reachedHandler: true, id: req.params.id }));
    app.use('/api/v1/workflows', router);
    return app;
  }

  it('lets a numeric id through to the handler', async () => {
    const res = await get(buildApp(), '/api/v1/workflows/123');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reachedHandler: true, id: '123' });
  });

  it('stops a non-numeric id before the handler, with SQLite\'s 404', async () => {
    const res = await get(buildApp(), '/api/v1/workflows/types-x');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'invalid_id' });
    // The point of the guard: the handler never ran, so nothing reached the database.
    expect(res.body.reachedHandler).toBeUndefined();
  });

  it('does not shadow a literal route registered before /:id', async () => {
    // The guard runs only once Express has chosen the /:id route, so a literal sibling declared
    // ahead of it is untouched. Written the other way round first, this test failed with a 404 —
    // which is the honest behaviour: a literal declared AFTER /:id was already unreachable, and
    // the guard changes its response from a 500 (PostgreSQL) to a clean 404, not from a 200.
    const res = await get(buildApp(), '/api/v1/workflows/types');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ literalRoute: true });
  });

  it('is registered on every router that declares an :id route', () => {
    // A structural assertion, because the failure mode is silent: a new router with an /:id route
    // and no param guard reintroduces the 500 with nothing to indicate it. Kept here rather than
    // in a lint rule so it runs with the suite.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const dir = path.join(__dirname, '..', 'routes');
    const missing = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        return src.includes("'/:id") && !src.includes("router.param('id'");
      });
    expect(missing).toEqual([]);
  });
});
