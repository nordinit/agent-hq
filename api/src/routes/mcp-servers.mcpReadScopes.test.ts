import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import {
  authenticateMcpApiKeyIfPresent,
  authorizeMcpApiRequestIfPresent,
  ensureMcpApiKeyTable,
  issueMcpApiKeyForAgent,
  replaceAgentMcpPermissionPolicy,
} from '../lib/mcpApiAuth';
import mcpServersRouter, { agentMcpServersRouter } from './mcp-servers';

describe('MCP server registry read scopes', () => {
  let tempDir: string;
  let server: Server | null = null;
  let baseUrl = '';
  let readKey = '';
  let adminKey = '';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-read-scopes-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq.db');
    closeDb();

    const db = getDb();
    db.exec(`
      CREATE TABLE tenants (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        system_role TEXT,
        deleted_at TEXT
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        project_id INTEGER,
        sprint_id INTEGER,
        agent_id INTEGER,
        active_instance_id INTEGER
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        status TEXT
      );
      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        author TEXT,
        content TEXT
      );
      CREATE TABLE mcp_servers (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL DEFAULT 'stdio',
        command TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        cwd TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agent_mcp_assignments (
        id INTEGER PRIMARY KEY,
        agent_id INTEGER NOT NULL,
        mcp_server_id INTEGER NOT NULL,
        overrides TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(agent_id, mcp_server_id)
      );
      INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default', 'default', 1);
      INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1');
      INSERT INTO agents (id, tenant_id, name, enabled, system_role) VALUES (7, 1, 'Reader', 1, NULL), (8, 1, 'Admin', 1, 'admin');
      INSERT INTO mcp_servers (id, tenant_id, name, slug, command, env) VALUES
        (30, 1, 'Agent HQ MCP', 'agent-hq', 'node', '{"AGENT_HQ_MCP_API_KEY":"secret","SAFE_FLAG":"yes"}');
      INSERT INTO agent_mcp_assignments (id, agent_id, mcp_server_id, overrides, enabled) VALUES (40, 7, 30, '{}', 1);
    `);
    ensureMcpApiKeyTable(db);
    readKey = issueMcpApiKeyForAgent(db, 7).apiKey;
    adminKey = issueMcpApiKeyForAgent(db, 8).apiKey;
    replaceAgentMcpPermissionPolicy(db, 7, ['mcp_servers.read']);

    const app = express();
    app.use(express.json());
    app.use('/api/v1', authenticateMcpApiKeyIfPresent);
    app.use('/api/v1', authorizeMcpApiRequestIfPresent);
    app.use('/api/v1/mcp-servers', mcpServersRouter);
    app.use('/api/v1/agents/:agentId/mcp-servers', agentMcpServersRouter);

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
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function authHeaders(apiKey: string): Record<string, string> {
    return {
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
      authorization: `Bearer ${apiKey}`,
    };
  }

  it('redacts MCP server environment values for read-scoped MCP credentials', async () => {
    const response = await fetch(`${baseUrl}/api/v1/mcp-servers/30`, { headers: authHeaders(readKey) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 30,
      env: '{"AGENT_HQ_MCP_API_KEY":"[redacted]","SAFE_FLAG":"[redacted]"}',
    });

    const assignments = await fetch(`${baseUrl}/api/v1/agents/7/mcp-servers`, { headers: authHeaders(readKey) });
    expect(assignments.status).toBe(200);
    await expect(assignments.json()).resolves.toEqual([
      expect.objectContaining({
        mcp_server_id: 30,
        env: '{"AGENT_HQ_MCP_API_KEY":"[redacted]","SAFE_FLAG":"[redacted]"}',
      }),
    ]);
  });

  it('preserves MCP server environment values for full-admin MCP credentials', async () => {
    const response = await fetch(`${baseUrl}/api/v1/mcp-servers/30`, { headers: authHeaders(adminKey) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 30,
      env: '{"AGENT_HQ_MCP_API_KEY":"secret","SAFE_FLAG":"yes"}',
    });
  });
});
