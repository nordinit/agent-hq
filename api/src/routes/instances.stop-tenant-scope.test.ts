import type { Request, Response } from 'express';

import type { Db } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';

let db: Db;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

jest.mock('../lib/tenantContext', () => ({
  resolveTenantIdFromRequest: jest.fn(),
}));

jest.mock('../domains/runs/stopInstanceExecution', () => ({
  stopInstanceExecution: jest.fn(),
}));

import { stopInstanceExecution } from '../domains/runs/stopInstanceExecution';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { stopInstanceRoute } from './instances';

const mockedResolveTenant = resolveTenantIdFromRequest as jest.MockedFunction<typeof resolveTenantIdFromRequest>;
const mockedStopInstance = stopInstanceExecution as jest.MockedFunction<typeof stopInstanceExecution>;

async function invokeStop(id: number): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 200;
  let body: Record<string, unknown> = {};
  const request = {
    params: { id: String(id) },
    body: { behavior: 'stop' },
  } as unknown as Request;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: Record<string, unknown>) {
      body = value;
      return this;
    },
  } as unknown as Response;
  await stopInstanceRoute(request, response);
  return { status, body };
}

describe('PUT /api/v1/instances/:id/stop tenant boundary', () => {
  beforeEach(async () => {
    db = await setupTestDb();
    await db.exec(`
      INSERT INTO tenants (id, name, slug, is_default)
      VALUES (1, 'Runtime One', 'runtime-one', 1), (2, 'Runtime Two', 'runtime-two', 0);
      INSERT INTO agents (id, tenant_id, name, role, session_key, runtime_type, runtime_config)
      VALUES
        (11, 1, 'Runtime One', 'test', 'agent:one', 'claude-code', '{}'),
        (22, 2, 'Runtime Two', 'test', 'agent:two', 'claude-code', '{}');
      INSERT INTO job_instances (id, tenant_id, agent_id, status)
      VALUES (100, 1, 11, 'running'), (200, 2, 22, 'running');
    `);
    mockedResolveTenant.mockReset().mockResolvedValue(1);
    mockedStopInstance.mockReset().mockResolvedValue({
      id: 100,
      behavior: 'stop',
      result: 'confirmed_stopped',
      message: 'Run stopped successfully.',
      runtimeUncertain: false,
      sessionKey: null,
      abortAttempted: false,
      abortOk: null,
      abortStatus: null,
      abortError: null,
      cronRemoved: false,
      cronRemoveError: null,
      taskId: null,
      taskStatusBefore: null,
      taskStatusAfter: null,
      clearedTaskLinkage: false,
    });
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('returns 404 for another tenant without invoking the stop domain', async () => {
    const response = await invokeStop(200);

    expect(response).toEqual({ status: 404, body: { error: 'Instance not found' } });
    expect(mockedResolveTenant).toHaveBeenCalledTimes(1);
    expect(mockedStopInstance).not.toHaveBeenCalled();
  });

  it('passes the resolved tenant into the stop domain for an owned instance', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await invokeStop(100);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, id: 100, result: 'confirmed_stopped' });
      expect(mockedStopInstance).toHaveBeenCalledWith(db, 100, 1, 'stop');
    } finally {
      log.mockRestore();
    }
  });
});
