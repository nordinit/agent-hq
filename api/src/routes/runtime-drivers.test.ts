import express from 'express';
import { AddressInfo } from 'net';
import { jest } from '@jest/globals';

const db = {
  get: jest.fn<(...args: any[]) => Promise<any>>(),
};

jest.mock('../db/client', () => ({ getDb: () => db }));
jest.mock('../lib/tenantContext', () => ({
  resolveTenantIdFromRequest: jest.fn(async () => 7),
}));
jest.mock('../domains/runtimes/driverDiagnostics', () => ({
  diagnoseRuntimeDriver: jest.fn(async (input: Record<string, unknown>) => ({
    ok: true,
    runtime_type: input.runtimeType,
    agent_id: input.agentId ?? null,
    checked_at: '2026-08-04T00:00:00.000Z',
    duration_ms: 1,
    command: 'codex',
    executable_path: '/usr/local/bin/codex',
    version: 'codex-cli 0.146.0',
    workspace_path: input.workspacePath,
    checks: [],
  })),
}));

import runtimeDriversRouter from './runtime-drivers';
import { diagnoseRuntimeDriver } from '../domains/runtimes/driverDiagnostics';

async function requestJson(app: express.Express, body: unknown): Promise<{ status: number; body: any }> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/runtime-drivers/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('POST /api/v1/runtime-drivers/diagnose', () => {
  const app = express().use(express.json()).use('/api/v1/runtime-drivers', runtimeDriversRouter);

  beforeEach(() => {
    db.get.mockReset();
    jest.mocked(diagnoseRuntimeDriver).mockClear();
  });

  it('diagnoses a tenant-scoped stored agent', async () => {
    db.get.mockResolvedValue({
      id: 42,
      runtime_type: 'codex',
      runtime_config: JSON.stringify({ codexBin: 'codex', sandboxMode: 'workspace-write' }),
      workspace_path: '/worktrees/task-42',
    });

    const response = await requestJson(app, { agent_id: 42 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, runtime_type: 'codex', agent_id: 42 });
    expect(db.get).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), 42, 7);
    expect(diagnoseRuntimeDriver).toHaveBeenCalledWith(expect.objectContaining({
      runtimeType: 'codex',
      runtimeConfig: { codexBin: 'codex', sandboxMode: 'workspace-write' },
      workspacePath: '/worktrees/task-42',
      agentId: 42,
    }));
  });

  it('rejects a runtime override that does not match the stored agent', async () => {
    db.get.mockResolvedValue({
      id: 42,
      runtime_type: 'claude-code',
      runtime_config: '{}',
      workspace_path: '/worktrees/task-42',
    });

    const response = await requestJson(app, { agent_id: 42, runtime_type: 'codex' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("does not match agent runtime 'claude-code'");
    expect(diagnoseRuntimeDriver).not.toHaveBeenCalled();
  });

  it('accepts a standalone draft diagnostic', async () => {
    const response = await requestJson(app, {
      runtime_type: 'codex',
      runtime_config: { codexBin: 'codex' },
      workspace_path: '/draft/workspace',
    });
    expect(response.status).toBe(200);
    expect(db.get).not.toHaveBeenCalled();
    expect(diagnoseRuntimeDriver).toHaveBeenCalledWith(expect.objectContaining({
      runtimeType: 'codex',
      agentId: null,
    }));
  });
});
