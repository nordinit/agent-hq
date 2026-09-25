import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import {
  AGENT_MCP_CAPABILITY_CATALOG,
  authorizeMcpApiRequestIfPresent,
  issueMcpApiKeyForAgent,
  replaceAgentMcpPermissionPolicy,
} from './mcpApiAuth';
import { handleJsonRequestErrors } from './jsonRequestErrors';
import { authenticateTestApiRequest } from './testApiAuth';

/**
 * Scoped MCP identities must not reach anything that runs code on the host or chooses what runs:
 * registry tools, MCP server launch definitions, workflow environment setup, runtime diagnostics
 * and onboarding probes, workspace file access, and the agent fields that select executables,
 * paths, bypass modes, remote endpoints and credentials. The handler behind every path here
 * answers 200, so a 403 can only come from the authorization layer.
 */
describe('scoped MCP keys and host execution', () => {
  let server: Server | null = null;
  let baseUrl = '';
  let scopedKey = '';
  let adminKey = '';

  const allScopedCapabilities = AGENT_MCP_CAPABILITY_CATALOG
    .map((capability) => capability.key)
    .filter((key) => !key.startsWith('admin.'));

  beforeEach(async () => {
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (86, 1, 'Agent HQ')`);
    await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES (42, 1, 86, 'Delivery', 'dev', 'active')`);
    await db.run(`
      INSERT INTO agents (id, tenant_id, project_id, name, session_key, enabled, workspace_path, runtime_type, runtime_config)
      VALUES (7, 1, 86, 'Connector', 'agent:connector:main', 1, '', 'openclaw', NULL),
             (8, 1, 86, 'Operator Bot', 'agent:operator-bot:main', 1, '', 'openclaw', NULL),
             (9, 1, 86, 'Builder', 'agent:builder:main', 1, '/srv/workspaces/builder', 'claude-code',
              '{"claudeBin":"claude","model":"claude-sonnet","permissionMode":"allowlist","workingDirectory":"/srv/workspaces/builder"}')
    `);
    scopedKey = (await issueMcpApiKeyForAgent(db, 7)).apiKey;
    adminKey = (await issueMcpApiKeyForAgent(db, 8, 'Admin', 'admin')).apiKey;
    // Every capability a scoped key can hold, so any refusal below is about host execution.
    await replaceAgentMcpPermissionPolicy(db, 7, allScopedCapabilities);

    // Ordered as in index.ts: authenticate, parse, then authorize against the body.
    const app = express();
    app.use('/api/v1', authenticateTestApiRequest());
    app.use(express.json());
    app.use(handleJsonRequestErrors);
    app.use('/api/v1', authorizeMcpApiRequestIfPresent);
    app.all('/api/v1/*', (req, res) => res.json({ reached: true, method: req.method, path: req.path }));
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
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
    await teardownTestDb();
  });

  const call = async (method: string, route: string, body?: unknown, key = scopedKey) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-agent-hq-mcp-client': 'agent-hq-mcp',
        authorization: `Bearer ${key}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  it('keeps host-executing administration routes behind admin.full_access', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['POST', '/api/v1/tools', { name: 'Shell', slug: 'shell', implementation_type: 'bash', implementation_body: 'id' }],
      ['PUT', '/api/v1/tools/1', { implementation_type: 'script', implementation_body: '{"command":"/bin/sh"}' }],
      ['POST', '/api/v1/tools/1/test', { input: {} }],
      ['POST', '/api/v1/agents/9/tools', { tool_id: 1 }],
      ['POST', '/api/v1/mcp-servers', { name: 'x', slug: 'x', command: '/bin/sh', args: ['-c', 'id'] }],
      ['PUT', '/api/v1/mcp-servers/1', { command: '/bin/sh', env: { LD_PRELOAD: '/tmp/x.so' }, cwd: '/' }],
      ['POST', '/api/v1/agents/9/mcp-servers', { mcp_server_id: 1 }],
      ['POST', '/api/v1/workflows', { project_id: 86, name: 'x', environment_setup: { mode: 'custom', steps: [{ command: ['sh', '-c', 'id'] }] } }],
      ['PUT', '/api/v1/workflows/42', { status: 'active', environment_setup: { mode: 'custom', steps: [{ command: ['sh'] }] } }],
      ['PUT', '/api/v1/workflows/42', { environment_setup: { mode: 'custom', steps: [{ command: ['sh'] }] } }],
      ['POST', '/api/v1/runtime-drivers/diagnose', { runtime_type: 'hermes', runtime_config: { profile: 'x', hermesBin: '/bin/sh' } }],
      ['POST', '/api/v1/setup/runtime/test', { kind: 'custom', endpoint: 'http://169.254.169.254' }],
      ['GET', '/api/v1/settings/gateway/config'],
      ['GET', '/api/v1/artifacts/file?agentId=9&path=.env'],
      ['PUT', '/api/v1/artifacts/file?agentId=9&path=run.sh', { content: '#!/bin/sh' }],
      ['POST', '/api/v1/agents/9/skills/sync', { working_directory: '/' }],
      ['POST', '/api/v1/agents/9/mcp/sync', {}],
      ['POST', '/api/v1/agents/9/provision', {}],
      ['POST', '/api/v1/agents/provision-full', { name: 'x', project_id: 86 }],
      ['POST', '/api/v1/projects/import', {}],
    ];
    for (const [method, route, body] of routes) {
      const res = await call(method, route, body);
      expect({ method, route, status: res.status, required: res.body.details?.required_capability })
        .toEqual({ method, route, status: 403, required: 'admin.full_access' });
    }

    // The same requests with an administrative key reach the handler, so the refusals above
    // are the policy and not a missing route.
    for (const [method, route, body] of routes) {
      const res = await call(method, route, body, adminKey);
      expect({ method, route, status: res.status }).toEqual({ method, route, status: 200 });
    }
  });

  it('refuses agent edits that change what runs, where, or with which credentials', async () => {
    const edits: Array<Record<string, unknown>> = [
      { workspace_path: '/' },
      { runtime_type: 'codex' },
      { hooks_url: 'https://attacker.example' },
      { hooks_auth_header: 'Bearer stolen' },
      { os_user: 'root' },
      { github_identity_id: 3 },
      // runtime_config replaces the stored object, so each of these differs from it.
      { runtime_config: { claudeBin: '/bin/sh', model: 'claude-sonnet', permissionMode: 'allowlist', workingDirectory: '/srv/workspaces/builder' } },
      { runtime_config: { claudeBin: 'claude', model: 'claude-sonnet', permissionMode: 'bypass', allowDangerousBypass: true, workingDirectory: '/srv/workspaces/builder' } },
      { runtime_config: { claudeBin: 'claude', model: 'claude-sonnet', permissionMode: 'allowlist', workingDirectory: '/' } },
      { runtime_config: { claudeBin: 'claude', model: 'claude-sonnet', permissionMode: 'allowlist', workingDirectory: '/srv/workspaces/builder', claudeConfigDir: '/Users/operator/.claude' } },
      { runtime_config: { claudeBin: 'claude', model: 'claude-sonnet', permissionMode: 'allowlist', workingDirectory: '/srv/workspaces/builder', env: { GIT_SSH_COMMAND: 'sh' } } },
      { runtime_config: { claudeBin: 'claude', model: 'claude-sonnet', permissionMode: 'allowlist', workingDirectory: '/srv/workspaces/builder', extraArgs: ['--debug'] } },
      // Dropping stored keys is a change too.
      { runtime_config: { model: 'claude-opus' } },
    ];
    for (const body of edits) {
      const res = await call('PUT', '/api/v1/agents/9', body);
      expect({ body, status: res.status, required: res.body.details?.required_capability })
        .toEqual({ body, status: 403, required: 'admin.full_access' });
    }

    const creates: Array<Record<string, unknown>> = [
      { workspace_path: '/srv/workspaces/new' },
      { provision_openclaw: true },
      { hooks_url: 'http://10.0.0.5:18789' },
      { runtime_type: 'webhook', runtime_config: { dispatchUrl: 'http://169.254.169.254/latest/meta-data' } },
      { runtime_type: 'codex', runtime_config: { sandboxMode: 'danger-full-access', allowDangerousFullAccess: true } },
      { runtime_type: 'hermes', runtime_config: { profile: 'default', hermesBin: '/bin/sh' } },
    ];
    for (const extra of creates) {
      const res = await call('POST', '/api/v1/agents', { name: 'New Agent', project_id: 86, ...extra });
      expect({ extra, status: res.status }).toEqual({ extra, status: 403 });
    }
  });

  it('still lets project agent management edit instructions and model selection', async () => {
    // Host fields sent back exactly as stored are not changes.
    const roundTrip = await call('PUT', '/api/v1/agents/9', {
      job_instructions: 'Review every backend change.',
      workspace_path: '/srv/workspaces/builder',
      runtime_type: 'claude-code',
      runtime_config: {
        claudeBin: 'claude',
        model: 'claude-opus',
        effort: 'high',
        maxTurns: 40,
        permissionMode: 'allowlist',
        workingDirectory: '/srv/workspaces/builder',
      },
    });
    expect(roundTrip.status).toBe(200);

    await expect(call('PUT', '/api/v1/agents/9', { model: 'claude-opus', skill_names: ['create-task'] }).then((r) => r.status)).resolves.toBe(200);

    const created = await call('POST', '/api/v1/agents', {
      name: 'Reviewer',
      project_id: 86,
      runtime_type: 'claude-code',
      runtime_config: { model: 'claude-sonnet', effort: 'medium' },
    });
    expect(created.status).toBe(200);
  });
});
