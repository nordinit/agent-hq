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

test('init can skip provider setup and still complete minimal install', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/setup/onboarding/skip') && init.method === 'POST') {
      return jsonResponse(200, {
        ok: true,
        onboarding_completed: true,
        atlas_created: true,
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
          workflow: { name: body.workflow_name, sprint_type: 'dev' },
          workflows: [{
            template: { key: body.template_key, label: 'Development' },
            workflow: { name: body.workflow_name, sprint_type: 'dev' },
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
      return jsonResponse(201, { ok: true, project_id: 12, workflow_id: 34 });
    }
    if (url.endsWith('/api/v1/setup/onboarding/complete')) {
      return jsonResponse(200, { ok: true, onboarding_completed: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

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
  );

  assert.equal(requests.some(request => request.url.endsWith('/api/v1/setup/starter-plan/apply')), true);
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
