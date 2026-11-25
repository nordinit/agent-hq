import assert from 'node:assert/strict';
import test from 'node:test';
import { runInit } from './onboarding.mjs';

function makeIo(answers) {
  const queue = [...answers];
  return {
    async ask(_question, fallback = '') {
      const next = queue.shift();
      return next === undefined || next === '' ? fallback : next;
    },
    async confirm() {
      const next = queue.shift();
      return next === undefined ? true : next === true || next === 'y' || next === 'yes';
    },
    close() {},
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('init connects a selected provider and persists canonical slug', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/providers') && !init.method) {
      return jsonResponse(200, { providers: [], onboarding_provider_gate_passed: false, connected_count: 0 });
    }
    if (url.endsWith('/api/v1/providers') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.slug, 'openrouter');
      assert.equal(body.display_name, 'OpenRouter');
      assert.deepEqual(body.config, { api_key: 'sk-or-test' });
      return jsonResponse(201, {
        id: 7,
        slug: 'openrouter',
        display_name: 'OpenRouter',
        status: 'connected',
        config: {},
        validation: { ok: true, error: null },
      });
    }
    if (url.endsWith('/api/v1/providers/openrouter/models')) {
      return jsonResponse(200, { source: 'static', models: [{ id: 'openrouter/auto', label: 'OpenRouter Auto' }] });
    }
    if (url.endsWith('/api/v1/setup/runtime/detect')) {
      return jsonResponse(200, { ok: true, runtime: { kind: 'openclaw', endpoint: 'ws://127.0.0.1:17601' } });
    }
    if (url.endsWith('/api/v1/setup/onboarding/complete')) {
      return jsonResponse(200, { ok: true, onboarding_completed: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await runInit(
    { apiUrl: 'http://agent-hq.test' },
    { io: makeIo(['y', 'openrouter', 'sk-or-test', 'n']), fetch: fetchImpl, noExit: true, openBrowser() {} },
  );

  assert.equal(result.slug, 'openrouter');
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/setup/onboarding/complete')), true);
});

test('init connects an Anthropic subscription through a runtime-owned profile', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/providers') && !init.method) {
      return jsonResponse(200, { providers: [], onboarding_provider_gate_passed: false, connected_count: 0 });
    }
    if (url.endsWith('/api/v1/provider-connections/auth-instructions')) {
      return jsonResponse(200, { instructions: { command: 'openclaw', args: ['models', 'auth', 'login', '--provider', 'anthropic'], message: 'Authenticate with OpenClaw.' } });
    }
    if (url.endsWith('/api/v1/provider-connections/discover')) {
      return jsonResponse(200, { connections: [{ externalRef: 'builder/anthropic:work', displayName: 'Claude Work', metadata: { profile_id: 'anthropic:work' } }] });
    }
    if (url.endsWith('/api/v1/provider-connections') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, {
        provider_slug: 'anthropic',
        auth_mode: 'subscription',
        runtime_type: 'openclaw',
        external_ref: 'builder/anthropic:work',
        display_name: 'Claude Work',
        metadata: { profile_id: 'anthropic:work' },
        runtime_config: {},
      });
      return jsonResponse(201, { id: 41, display_name: 'Claude Work', status: 'connected' });
    }
    if (url.endsWith('/api/v1/providers/anthropic/models')) {
      return jsonResponse(200, { source: 'static', models: [{ id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }] });
    }
    if (url.endsWith('/api/v1/setup/runtime/detect')) return jsonResponse(200, { ok: true });
    if (url.endsWith('/api/v1/setup/onboarding/complete')) return jsonResponse(200, { ok: true, onboarding_completed: true });
    throw new Error(`Unexpected request: ${url}`);
  };

  const spawnCalls = [];
  const result = await runInit(
    { apiUrl: 'http://agent-hq.test' },
    {
      io: makeIo(['y', 'anthropic-subscription', 'openclaw', 'y', '1', 'n']),
      fetch: fetchImpl,
      spawnSync(command, args) { spawnCalls.push({ command, args }); return { status: 0 }; },
      noExit: true,
      openBrowser() {},
    },
  );

  assert.equal(result.slug, 'anthropic');
  assert.equal(result.provider_connection_id, 41);
  assert.deepEqual(spawnCalls, [{ command: 'openclaw', args: ['models', 'auth', 'login', '--provider', 'anthropic'] }]);
});

test('init can skip provider setup and still complete minimal install', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/setup/onboarding/skip') && init.method === 'POST') {
      return jsonResponse(200, {
        ok: true,
        onboarding_completed: true,
        onboarding_provider_gate_passed: false,
        connected_provider_count: 0,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await runInit(
    { apiUrl: 'http://agent-hq.test', skipProvider: true },
    { io: makeIo([]), fetch: fetchImpl, noExit: true, openBrowser() {} },
  );

  assert.equal(result.onboarding_completed, true);
  assert.equal(requests[0].url, 'http://agent-hq.test/api/v1/setup/onboarding/skip');
});

test('init can configure and test an OpenClaw runtime connection', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/providers') && !init.method) {
      return jsonResponse(200, { providers: [], onboarding_provider_gate_passed: false, connected_count: 0 });
    }
    if (url.endsWith('/api/v1/providers') && init.method === 'POST') {
      return jsonResponse(201, {
        id: 7,
        slug: 'openrouter',
        display_name: 'OpenRouter',
        status: 'connected',
        config: {},
        validation: { ok: true, error: null },
      });
    }
    if (url.endsWith('/api/v1/providers/openrouter/models')) {
      return jsonResponse(200, { source: 'static', models: [] });
    }
    if (url.endsWith('/api/v1/setup/runtime/detect')) {
      return jsonResponse(200, { ok: true, runtime: { kind: 'openclaw', endpoint: 'ws://127.0.0.1:17601' } });
    }
    if (url.endsWith('/api/v1/setup/runtime/config') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.kind, 'openclaw');
      assert.equal(body.endpoint, 'ws://127.0.0.1:17601');
      assert.equal(body.auth_token, 'gw-token');
      return jsonResponse(201, {
        ok: true,
        configured: true,
        runtime: { kind: 'openclaw', endpoint: body.endpoint },
        status: {
          kind: 'openclaw',
          endpoint: body.endpoint,
          state: 'healthy',
          auth_present: true,
          capabilities: ['chat.send'],
          callback_ready: true,
          callback_url: 'http://agent-hq.test',
          repair_guidance: [],
        },
      });
    }
    if (url.endsWith('/api/v1/setup/onboarding/complete')) {
      return jsonResponse(200, { ok: true, onboarding_completed: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await runInit(
    { apiUrl: 'http://agent-hq.test' },
    { io: makeIo(['y', 'openrouter', 'sk-or-test', 'y', 'openclaw', '', 'gw-token', 'n']), fetch: fetchImpl, noExit: true, openBrowser() {} },
  );

  assert.equal(requests.some(request => request.url.endsWith('/api/v1/setup/runtime/config')), true);
});

test('init previews editable ownership routing plan and applies starter template setup', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/providers') && !init.method) {
      return jsonResponse(200, { providers: [], onboarding_provider_gate_passed: false, connected_count: 0 });
    }
    if (url.endsWith('/api/v1/providers') && init.method === 'POST') {
      return jsonResponse(201, {
        id: 7,
        slug: 'openrouter',
        display_name: 'OpenRouter',
        status: 'connected',
        config: {},
        validation: { ok: true, error: null },
      });
    }
    if (url.endsWith('/api/v1/providers/openrouter/models')) {
      return jsonResponse(200, { source: 'static', models: [] });
    }
    if (url.endsWith('/api/v1/setup/runtime/detect')) {
      return jsonResponse(200, { ok: true, runtime: { kind: 'openclaw', endpoint: 'ws://127.0.0.1:17601' } });
    }
    if (url.endsWith('/api/v1/setup/runtime/config') && init.method === 'POST') {
      return jsonResponse(201, {
        ok: true,
        configured: true,
        runtime: { kind: 'openclaw', endpoint: 'ws://127.0.0.1:17601' },
        status: {
          kind: 'openclaw',
          endpoint: 'ws://127.0.0.1:17601',
          state: 'healthy',
          auth_present: true,
          capabilities: ['chat.send'],
          callback_ready: true,
          callback_url: 'http://agent-hq.test',
          repair_guidance: [],
        },
      });
    }
    if (url.endsWith('/api/v1/setup/templates')) {
      return jsonResponse(200, {
        templates: [{
          key: 'development',
          label: 'Development',
          description: 'MVP',
          fully_implemented: true,
          owner_roles: ['implementation', 'review', 'release', 'pm'],
        }],
      });
    }
    if (url.endsWith('/api/v1/setup/starter-plan/preview') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const routes = body.routing_plan ?? [
        { key: 'backend:ready', task_type: 'backend', status: 'ready', owner_role: 'implementation', owner_name: body.owners.implementation, enabled: true, priority: -100 },
        { key: 'backend:review', task_type: 'backend', status: 'review', owner_role: 'review', owner_name: body.owners.review, enabled: true, priority: -100 },
      ];
      return jsonResponse(200, {
        ok: true,
        plan: {
          template: { key: body.template_key, label: 'Development' },
          templates: [{ key: body.template_key, label: 'Development' }],
          project: { name: body.project_name },
          workflow: { name: body.workflow_name, workflow_type: 'dev' },
          workflows: [{
            template: { key: body.template_key, label: 'Development' },
            workflow: { name: body.workflow_name, workflow_type: 'dev' },
            statuses: ['todo', 'ready', 'review', 'done'],
            task_types: ['backend', 'frontend', 'fullstack', 'qa'],
            fields: [{ key: 'review_branch' }, { key: 'review_commit' }],
            verification: {
              evidence_gates: ['completed_for_review: review_branch, review_commit'],
              sample_route_checks: [{ task_type: 'backend', status: 'ready', expected_owner_role: 'implementation' }],
            },
          }],
          agents: [
            { owner_role: 'implementation', name: body.owners.implementation, runtime_type: 'openclaw', preferred_provider: 'openrouter', model: 'openrouter/auto' },
            { owner_role: 'review', name: body.owners.review, runtime_type: 'openclaw', preferred_provider: 'openrouter', model: 'openrouter/auto' },
            { owner_role: 'release', name: body.owners.release, runtime_type: 'openclaw', preferred_provider: 'openrouter', model: 'openrouter/auto' },
            { owner_role: 'pm', name: body.owners.pm, runtime_type: 'openclaw', preferred_provider: 'openrouter', model: 'openrouter/auto' },
          ],
          routes,
          model_routing: [],
          compatibility: { ok: true, errors: [], warnings: [] },
          preview: { changes: [{ action: 'create', resource: 'project', name: body.project_name, reason: 'test' }] },
          execution_access: { host_execute: true, summary: 'Each starter agent gets the host.execute permission.' },
          editable: { advanced_path: '/routing' },
        },
      });
    }
    if (url.endsWith('/api/v1/setup/starter-plan/apply') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.template_key, 'development');
      assert.deepEqual(body.template_keys, ['development']);
      assert.equal(body.owners.implementation, 'Dev Owner');
      assert.equal(body.routing_plan.some(route => route.key === 'backend:ready' && route.owner_name === 'QA Owner'), true);
      assert.equal(body.routing_plan.some(route => route.key === 'docs:ready'), true);
      return jsonResponse(201, { ok: true, project_id: 12, workflow_id: 34, execution_access: { host_execute_agent_ids: [1, 2, 3, 4], approved_revisions: 8, pending: [] } });
    }
    if (url.endsWith('/api/v1/setup/onboarding/complete')) {
      return jsonResponse(200, { ok: true, onboarding_completed: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const printed = [];
  const originalLog = console.log;
  console.log = (...args) => { printed.push(args.join(' ')); };
  await runInit(
    { apiUrl: 'http://agent-hq.test' },
    {
      io: makeIo([
        'y', 'openrouter', 'sk-or-test',
        'y', 'openclaw', '', 'gw-token',
        'y', 'development', 'Acme App', 'Delivery', 'Dev Owner', 'QA Owner', 'Release Owner', 'PM Owner',
        'y', 'owner', 'backend:ready', 'review', 'QA Owner',
        'y', 'add', 'docs', 'ready', 'pm', 'PM Owner',
        'n', 'y',
      ]),
      fetch: fetchImpl,
      noExit: true,
      openBrowser() {},
    },
  ).finally(() => { console.log = originalLog; });

  assert.equal(requests.some(request => request.url.endsWith('/api/v1/setup/starter-plan/apply')), true);
  // The review says the starter agents will be allowed to run here, and the result confirms it.
  assert.match(printed.join('\n'), /These agents can run on this machine:\n {2}Each starter agent gets the host\.execute permission\./);
  assert.match(printed.join('\n'), /4 starter agents are allowed to run on this machine \(host\.execute\)\./);
});

test('init surfaces provider validation failures without completing onboarding', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/providers') && !init.method) {
      return jsonResponse(200, { providers: [], onboarding_provider_gate_passed: false, connected_count: 0 });
    }
    if (url.endsWith('/api/v1/providers') && init.method === 'POST') {
      return jsonResponse(201, {
        id: 4,
        slug: 'anthropic',
        display_name: 'Anthropic',
        status: 'failed',
        config: {},
        validation: { ok: false, error: 'Anthropic could not verify your key.' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    runInit(
      { apiUrl: 'http://agent-hq.test' },
      { io: makeIo(['y', 'anthropic', 'bad-key']), fetch: fetchImpl, noExit: true, openBrowser() {} },
    ),
    /Anthropic could not verify your key/,
  );
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/setup/onboarding/complete')), false);
});

function starterRuntimes(claudeStatus) {
  const claudeReady = claudeStatus === 'ready';
  return {
    ok: true,
    recommended: 'claude-code',
    suggested: 'claude-code',
    options: [
      {
        type: 'claude-code', label: 'Claude Code', recommended: true, status: claudeStatus,
        message: claudeReady ? 'Claude Code is installed and logged in. The starter agents will use this login.' : 'Claude Code is installed but not logged in.',
        fix: claudeReady ? [] : ['claude auth login'],
        login: claudeReady ? { runtime_type: 'claude-code', provider_slug: 'anthropic', auth_mode: 'subscription', external_ref: 'claude-code:default', display_name: 'Claude subscription (Claude Code default profile)' } : null,
      },
      { type: 'codex', label: 'Codex', recommended: false, status: 'not_installed', message: 'Codex is not installed on this machine.', fix: ['npm install -g @openai/codex', 'codex login'], login: null },
      { type: 'openclaw', label: 'OpenClaw', recommended: false, status: 'needs_setup', message: 'Connect a model provider and an OpenClaw gateway in the next steps.', fix: [], login: null },
    ],
  };
}

test('init recommends Claude Code and sets up starter agents on it without a provider or gateway step', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/setup/starter-runtimes')) return jsonResponse(200, starterRuntimes('ready'));
    if (url.endsWith('/api/v1/setup/templates')) {
      return jsonResponse(200, { templates: [{ key: 'development', label: 'Development', description: 'MVP', fully_implemented: true, owner_roles: ['implementation'] }] });
    }
    if (url.endsWith('/api/v1/setup/starter-plan/preview') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.runtime_type, 'claude-code');
      return jsonResponse(200, {
        ok: true,
        plan: {
          template: { key: 'development', label: 'Development' },
          templates: [{ key: 'development', label: 'Development' }],
          project: { name: body.project_name },
          workflow: { name: body.workflow_name, workflow_type: 'dev' },
          workflows: [{ template: { key: 'development', label: 'Development' }, workflow: { name: body.workflow_name, workflow_type: 'dev' } }],
          agents: [{ owner_role: 'implementation', name: body.owners.implementation, runtime_type: 'claude-code', preferred_provider: 'anthropic', model: null }],
          runtime: starterRuntimes('ready').options[0],
          routes: [],
          model_routing: [],
          compatibility: { ok: true, runtime: 'claude-code', errors: [], warnings: [] },
          preview: { changes: [] },
          execution_access: { host_execute: true, summary: 'Each starter agent gets the host.execute permission.' },
          editable: { advanced_path: '/routing' },
        },
      });
    }
    if (url.endsWith('/api/v1/setup/starter-plan/apply') && init.method === 'POST') {
      assert.equal(JSON.parse(init.body).runtime_type, 'claude-code');
      return jsonResponse(201, { ok: true, project_id: 12, workflow_id: 34, provider_connection_id: 5, execution_access: { host_execute_agent_ids: [1], approved_revisions: 2, pending: [] } });
    }
    if (url.endsWith('/api/v1/setup/onboarding/complete')) return jsonResponse(200, { ok: true, onboarding_completed: true });
    throw new Error(`Unexpected request: ${url}`);
  };

  const printed = [];
  const originalLog = console.log;
  console.log = (...args) => { printed.push(args.join(' ')); };
  await runInit(
    { apiUrl: 'http://agent-hq.test' },
    { io: makeIo(['', 'y', 'development', 'Acme App', 'Delivery', 'Dev Owner', 'n', 'y']), fetch: fetchImpl, noExit: true, openBrowser() {} },
  ).finally(() => { console.log = originalLog; });

  const output = printed.join('\n');
  assert.match(output, /Where should your agents run\?\n {2}1\. Claude Code \(recommended\) - Ready: /);
  assert.match(output, /2\. Codex - Not installed: Codex is not installed on this machine\./);
  assert.match(output, /Runtime: Claude Code, using Claude subscription \(Claude Code default profile\)/);
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/setup/starter-plan/apply')), true);
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/setup/onboarding/complete')), true);
  // No model provider or OpenClaw gateway questions for a Claude Code setup.
  assert.equal(requests.some(request => /\/api\/v1\/(providers|setup\/runtime\/)/.test(request.url)), false);
});

test('init shows what to run until Claude Code is logged in, and records the login when no starter setup is applied', async () => {
  const requests = [];
  let checks = 0;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/setup/starter-runtimes')) {
      checks += 1;
      return jsonResponse(200, starterRuntimes(checks === 1 ? 'not_logged_in' : 'ready'));
    }
    if (url.endsWith('/api/v1/provider-connections') && init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), {
        provider_slug: 'anthropic', runtime_type: 'claude-code', auth_mode: 'subscription',
        external_ref: 'claude-code:default', display_name: 'Claude subscription (Claude Code default profile)',
      });
      return jsonResponse(201, { id: 5, status: 'connected' });
    }
    if (url.endsWith('/api/v1/setup/onboarding/complete')) return jsonResponse(200, { ok: true, onboarding_completed: true });
    throw new Error(`Unexpected request: ${url}`);
  };

  const printed = [];
  const originalLog = console.log;
  console.log = (...args) => { printed.push(args.join(' ')); };
  await runInit(
    { apiUrl: 'http://agent-hq.test' },
    { io: makeIo(['1', 'y', 'n']), fetch: fetchImpl, noExit: true, openBrowser() {} },
  ).finally(() => { console.log = originalLog; });

  assert.equal(checks, 2);
  assert.match(printed.join('\n'), /Claude Code is installed but not logged in\.\n {4}claude auth login/);
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/provider-connections')), true);
  assert.equal(requests.some(request => request.url.endsWith('/api/v1/setup/onboarding/complete')), true);
});
