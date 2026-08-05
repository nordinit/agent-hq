import type { Db, RunResult, SqlParam } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import type { RuntimeBoundaryV1 } from '../runtimes/runtimeBoundary';
import {
  assertRuntimeBoundaryAssignmentsCurrent,
  loadRuntimeBoundaryAssignments,
} from './runtimeBoundaryAssignments';

class FailingMcpAssignmentLookupDb implements Db {
  constructor(private readonly inner: Db) {}

  get inTransaction(): boolean {
    return this.inner.inTransaction;
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    return await this.inner.get<T>(sql, ...params);
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    if (/\bFROM\s+agent_mcp_assignments\b/i.test(sql)) {
      throw new Error('injected MCP registry outage');
    }
    return await this.inner.all<T>(sql, ...params);
  }

  async run(sql: string, ...params: SqlParam[]): Promise<RunResult> {
    return await this.inner.run(sql, ...params);
  }

  async value<T = unknown>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    return await this.inner.value<T>(sql, ...params);
  }

  async exec(sql: string): Promise<void> {
    await this.inner.exec(sql);
  }

  async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return await this.inner.withTransaction(async (tx) =>
      await fn(new FailingMcpAssignmentLookupDb(tx)));
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

describe('loadRuntimeBoundaryAssignments', () => {
  let db: Db;

  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`
      INSERT INTO tenants (id, name, slug) VALUES
        (1, 'Runtime Assignments', 'runtime-assignments'),
        (2, 'Other Tenant', 'other-tenant')
    `);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, skill_names)
      VALUES (14, 1, 'Runtime Test', 'test', 'agent:runtime-test:main', ?)
    `, JSON.stringify(['review', 'coding']));
    await db.run(`
      INSERT INTO skills (tenant_id, name, updated_at)
      VALUES (1, 'coding', '2026-08-05T12:00:00Z')
    `);
    await db.run(`
      INSERT INTO mcp_servers
        (id, tenant_id, name, slug, command, updated_at, enabled)
      VALUES
        (1, 1, 'Agent HQ', 'agent-hq', 'agent-hq-mcp', '2026-08-05T11:00:00Z', 1),
        (2, 1, 'Linear', 'linear', 'linear-mcp', '2026-08-05T11:30:00Z', 1),
        (3, 2, 'Cross tenant', 'cross-tenant', 'cross-tenant-mcp', '2026-08-05T11:45:00Z', 1)
    `);
    await db.run(`
      INSERT INTO agent_mcp_assignments
        (id, agent_id, mcp_server_id, overrides, enabled)
      VALUES
        (10, 14, 1, '{}', 1),
        (11, 14, 2, ?, 1),
        (12, 14, 3, '{}', 1)
    `, JSON.stringify({
      allowed_tools: ['issue_update', 'issue_read'],
      env: { LINEAR_TOKEN: 'never-persist-me' },
    }));
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('loads revision references and tool policy without materialized config or secrets', async () => {
    const assignments = await loadRuntimeBoundaryAssignments({
      db,
      tenantId: 1,
      agentId: 14,
      requiredLifecycleTools: ['agent_hq_start_task_run', 'agent_hq_post_task_outcome'],
    });

    expect(assignments.skills).toEqual([
      { name: 'coding', revision: '2026-08-05T12:00:00Z' },
      { name: 'review', revision: null },
    ]);
    expect(assignments.mcpServers).toEqual([
      {
        name: 'agent-hq__agent-14',
        configFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        requiredToolNames: ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'],
      },
      {
        name: 'linear__agent-14',
        configFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        requiredToolNames: ['issue_read', 'issue_update'],
      },
    ]);
    expect(JSON.stringify(assignments)).not.toContain('never-persist-me');
  });

  it('fails closed when an assigned skill has no tenant-scoped registry record', async () => {
    await expect(loadRuntimeBoundaryAssignments({
      db,
      tenantId: 1,
      agentId: 14,
      requiredLifecycleTools: ['agent_hq_start_task_run'],
      failClosed: true,
    })).rejects.toThrow(/assigned skill records are missing: review/);
  });

  it('fails closed instead of treating invalid MCP overrides as an empty policy', async () => {
    await db.run('UPDATE agent_mcp_assignments SET overrides = ? WHERE id = 11', '{not-json');

    await expect(loadRuntimeBoundaryAssignments({
      db,
      tenantId: 1,
      agentId: 14,
      skillNames: ['coding'],
      failClosed: true,
    })).rejects.toThrow(/MCP assignment overrides are invalid/);
  });

  it('fails closed when the tenant-scoped registry cannot be queried', async () => {
    await expect(loadRuntimeBoundaryAssignments({
      db: new FailingMcpAssignmentLookupDb(db),
      tenantId: 1,
      agentId: 14,
      skillNames: ['coding'],
      failClosed: true,
    })).rejects.toThrow(/MCP assignment lookup failed/);
  });

  it('revalidates exact MCP fingerprints, skill revisions, and materialized names', async () => {
    await db.run(
      'UPDATE agents SET skill_names = ? WHERE id = 14',
      JSON.stringify(['coding']),
    );
    const assignments = await loadRuntimeBoundaryAssignments({
      db,
      tenantId: 1,
      agentId: 14,
      skillNames: ['coding'],
      requiredLifecycleTools: ['agent_hq_start_task_run'],
      failClosed: true,
    });
    const boundary = {
      identity: { tenantId: 1, agentId: 14 },
      tools: {
        mcpServers: assignments.mcpServers,
        skills: assignments.skills,
        requiredLifecycleTools: ['agent_hq_start_task_run'],
      },
    } as unknown as RuntimeBoundaryV1;
    const materializedMcpServerNames = assignments.mcpServers.map((assignment) => assignment.name);

    await expect(assertRuntimeBoundaryAssignmentsCurrent({
      db,
      boundary,
      materializedMcpServerNames,
    })).resolves.toBeUndefined();

    await expect(assertRuntimeBoundaryAssignmentsCurrent({
      db,
      boundary,
      materializedMcpServerNames: materializedMcpServerNames.slice(0, 1),
    })).rejects.toThrow(/Materialized MCP servers do not match/);

    await db.run(
      "UPDATE mcp_servers SET updated_at = '2026-08-05T13:00:00Z' WHERE id = 2",
    );
    await expect(assertRuntimeBoundaryAssignmentsCurrent({
      db,
      boundary,
      materializedMcpServerNames,
    })).rejects.toThrow(/MCP assignments changed/);

    await db.run(
      "UPDATE mcp_servers SET updated_at = '2026-08-05T11:30:00Z' WHERE id = 2",
    );
    await db.run(
      "UPDATE skills SET updated_at = '2026-08-05T14:00:00Z' WHERE tenant_id = 1 AND name = 'coding'",
    );
    await expect(assertRuntimeBoundaryAssignmentsCurrent({
      db,
      boundary,
      materializedMcpServerNames,
    })).rejects.toThrow(/skill assignments changed/i);

    await db.run(
      "UPDATE skills SET updated_at = '2026-08-05T12:00:00Z' WHERE tenant_id = 1 AND name = 'coding'",
    );
    await db.run(
      'UPDATE agents SET skill_names = ? WHERE id = 14',
      JSON.stringify(['coding', 'review']),
    );
    await db.run(
      "INSERT INTO skills (tenant_id, name, updated_at) VALUES (1, 'review', '2026-08-05T12:30:00Z')",
    );
    await expect(assertRuntimeBoundaryAssignmentsCurrent({
      db,
      boundary,
      materializedMcpServerNames,
    })).rejects.toThrow(/skill assignments changed/i);
  });
});
