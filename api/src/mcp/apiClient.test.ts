import { AgentHqApiClient, AgentHqApiError } from './apiClient';
import { formatMcpToolError } from './registrar';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function installMoveTaskFetchMock() {
  const postedBodies: unknown[] = [];
  const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url === 'http://agent-hq.test/api/v1/tasks/42') {
      return jsonResponse({
        id: 42,
        title: 'Configured outcome task',
        status: 'in_progress',
        priority: 'medium',
        task_type: 'backend',
        story_points: null,
        project_id: 1,
        sprint_id: 10,
        sprint_name: 'Configurable outcomes',
        agent_id: null,
        agent_name: null,
        active_instance_id: null,
        blockers: [],
        blocking: [],
        description: '',
        integrity_warnings: [],
        changed_files: [],
      });
    }

    if (method === 'GET' && url === 'http://agent-hq.test/api/v1/routing/transitions?sprint_id=10&project_id=1') {
      return jsonResponse({
        transitions: [
          {
            id: 1,
            sprint_id: 10,
            project_id: 1,
            task_type: null,
            from_status: 'in_progress',
            outcome: 'completed_for_review',
            to_status: 'review',
            enabled: 1,
            priority: 0,
          },
          {
            id: 2,
            sprint_id: 10,
            project_id: 1,
            task_type: 'backend',
            from_status: 'in_progress',
            outcome: 'ship_it',
            to_status: 'review',
            enabled: 1,
            priority: 5,
          },
        ],
      });
    }

    if (method === 'POST' && url === 'http://agent-hq.test/api/v1/tasks/42/outcome') {
      postedBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return jsonResponse({ ok: true });
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({ error: `Unexpected request: ${method} ${url}` }),
      text: async () => JSON.stringify({ error: `Unexpected request: ${method} ${url}` }),
    } as Response;
  });

  (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, postedBodies };
}

describe('AgentHqApiClient.moveTask configured outcomes', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('uses the configured sprint transition outcome for status-targeted moves', async () => {
    const { postedBodies } = installMoveTaskFetchMock();
    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.moveTask(42, { status: 'review', summary: 'Ready for review' });

    expect(postedBodies).toEqual([
      expect.objectContaining({
        outcome: 'ship_it',
        summary: 'Ready for review',
      }),
    ]);
  });

  it('can target workflow-defined statuses that are not in the legacy default status list', async () => {
    const postedBodies: unknown[] = [];
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (method === 'GET' && url === 'http://agent-hq.test/api/v1/tasks/77') {
        return jsonResponse({
          id: 77,
          title: 'Custom workflow status task',
          status: 'todo',
          priority: 'medium',
          task_type: 'backend',
          story_points: null,
          project_id: 1,
          sprint_id: 10,
          sprint_name: 'Field workflow',
          agent_id: null,
          agent_name: null,
          active_instance_id: null,
          blockers: [],
          blocking: [],
          description: '',
          integrity_warnings: [],
          changed_files: [],
        });
      }

      if (method === 'GET' && url === 'http://agent-hq.test/api/v1/routing/transitions?sprint_id=10&project_id=1') {
        return jsonResponse({
          transitions: [
            {
              id: 9,
              sprint_id: 10,
              project_id: 1,
              task_type: 'backend',
              from_status: 'todo',
              outcome: 'ready_for_field_report',
              to_status: 'field_reported',
              enabled: 1,
              priority: 10,
            },
          ],
        });
      }

      if (method === 'POST' && url === 'http://agent-hq.test/api/v1/tasks/77/outcome') {
        postedBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ ok: true, status: 'field_reported' });
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ error: `Unexpected request: ${method} ${url}` }),
        text: async () => JSON.stringify({ error: `Unexpected request: ${method} ${url}` }),
      } as Response;
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.moveTask(77, { status: 'field_reported', summary: 'Custom workflow handoff' });

    expect(postedBodies).toEqual([
      expect.objectContaining({
        outcome: 'ready_for_field_report',
        summary: 'Custom workflow handoff',
      }),
    ]);
  });


  it('shows the configured outcome in dry-run previews', async () => {
    const { postedBodies } = installMoveTaskFetchMock();
    const client = new AgentHqApiClient('http://agent-hq.test');

    const preview = await client.moveTask(42, { status: 'review', dry_run: true });

    expect(preview).toEqual({
      dry_run: true,
      preview: {
        method: 'POST',
        path: '/api/v1/tasks/42/outcome',
        body: expect.objectContaining({ outcome: 'ship_it' }),
      },
    });
    expect(postedBodies).toEqual([]);
  });

  it('preserves structured workflow allowed-values errors for MCP tool output', async () => {
    const structuredError = {
      error: '"not_in_workflow" is not a valid task status for this workflow. Valid values: todo, field_reported',
      code: 'task_status_not_allowed_for_workflow',
      field: 'status',
      attempted_value: 'not_in_workflow',
      allowed_values: ['todo', 'field_reported'],
      metadata_tool: 'agent_hq_get_workflow_metadata',
      workflow: {
        sprint_id: 10,
        sprint_type: 'field_ops',
        task_type: 'backend',
        from_status: 'todo',
      },
    };
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (method === 'GET' && url === 'http://agent-hq.test/api/v1/tasks/78') {
        return jsonResponse({
          id: 78,
          title: 'Invalid custom workflow status task',
          status: 'todo',
          priority: 'medium',
          task_type: 'backend',
          story_points: null,
          project_id: 1,
          sprint_id: 10,
          sprint_name: 'Field workflow',
          agent_id: null,
          agent_name: null,
          active_instance_id: null,
          blockers: [],
          blocking: [],
          description: '',
          integrity_warnings: [],
          changed_files: [],
        });
      }

      if (method === 'GET' && url === 'http://agent-hq.test/api/v1/routing/transitions?sprint_id=10&project_id=1') {
        return jsonResponse({ transitions: [] });
      }

      if (method === 'PUT' && url === 'http://agent-hq.test/api/v1/tasks/78') {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify(structuredError),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: `Unexpected request: ${method} ${url}` }),
      } as Response;
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');
    let thrown: unknown;
    try {
      await client.moveTask(78, { status: 'not_in_workflow' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AgentHqApiError);
    expect(thrown).toMatchObject({
      message: structuredError.error,
      status: 400,
      body: structuredError,
    });
    expect(formatMcpToolError(thrown)).toEqual({
      ok: false,
      error: structuredError.error,
      code: 'task_status_not_allowed_for_workflow',
      field: 'status',
      attempted_value: 'not_in_workflow',
      allowed_values: ['todo', 'field_reported'],
      metadata_tool: 'agent_hq_get_workflow_metadata',
      workflow: structuredError.workflow,
    });
  });
});

describe('AgentHqApiClient lifecycle write helpers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('posts structured lifecycle writes to the expected endpoints', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({
        method: String(init?.method ?? 'GET'),
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({ ok: true });
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.startInstance(2551, { session_key: 'run:2551' });
    await client.checkInInstance(2551, { stage: 'progress', summary: 'Implemented lifecycle tools', meaningful_output: true });
    await client.addTaskNote(448, 'Lifecycle note with "quotes"', 'cinder-backend');
    await client.recordReviewEvidence(448, {
      review_branch: 'cinder-backend/task-448',
      review_commit: 'abc123',
      review_url: 'http://localhost:3510/review/448',
    });
    await client.recordQaEvidence(448, { qa_verified_commit: 'abc123', qa_tested_url: 'http://localhost:3510/review/448' });
    await client.recordDeployEvidence(448, { deployed_commit: 'def456', deploy_target: 'production' });
    await client.recordLiveVerification(448, { live_verified_by: 'cinder-backend' });
    await client.postTaskOutcome(448, {
      outcome: 'completed_for_review',
      summary: 'Ready for review',
      instance_id: 2551,
      review_branch: 'cinder-backend/task-448',
      review_commit: 'abc123',
    });

    expect(calls).toEqual([
      {
        method: 'PUT',
        url: 'http://agent-hq.test/api/v1/instances/2551/start',
        body: { session_key: 'run:2551' },
      },
      {
        method: 'POST',
        url: 'http://agent-hq.test/api/v1/instances/2551/check-in',
        body: { stage: 'progress', summary: 'Implemented lifecycle tools', meaningful_output: true },
      },
      {
        method: 'POST',
        url: 'http://agent-hq.test/api/v1/tasks/448/notes',
        body: { content: 'Lifecycle note with "quotes"', author: 'cinder-backend', source: 'mcp' },
      },
      {
        method: 'PUT',
        url: 'http://agent-hq.test/api/v1/tasks/448/review-evidence',
        body: {
          review_branch: 'cinder-backend/task-448',
          review_commit: 'abc123',
          review_url: 'http://localhost:3510/review/448',
        },
      },
      {
        method: 'PUT',
        url: 'http://agent-hq.test/api/v1/tasks/448/qa-evidence',
        body: { qa_verified_commit: 'abc123', qa_tested_url: 'http://localhost:3510/review/448' },
      },
      {
        method: 'PUT',
        url: 'http://agent-hq.test/api/v1/tasks/448/deploy-evidence',
        body: { deployed_commit: 'def456', deploy_target: 'production' },
      },
      {
        method: 'PUT',
        url: 'http://agent-hq.test/api/v1/tasks/448/live-verification',
        body: { live_verified_by: 'cinder-backend' },
      },
      {
        method: 'POST',
        url: 'http://agent-hq.test/api/v1/tasks/448/outcome',
        body: {
          outcome: 'completed_for_review',
          summary: 'Ready for review',
          instance_id: 2551,
          review_branch: 'cinder-backend/task-448',
          review_commit: 'abc123',
        },
      },
    ]);
  });

  it('preserves quoted summaries and inline failure metadata in structured outcome writes', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({
        method: String(init?.method ?? 'GET'),
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({ ok: true });
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.postTaskOutcome(448, {
      outcome: 'failed',
      summary: 'Outcome summary with "quotes" and JSON-ish {payload} text',
      instance_id: 2551,
      blocker_reason: 'Dependency said "no"',
      failure_detail: 'Parser refused raw curl JSON',
    });

    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'http://agent-hq.test/api/v1/tasks/448/outcome',
        body: {
          outcome: 'failed',
          summary: 'Outcome summary with "quotes" and JSON-ish {payload} text',
          instance_id: 2551,
          blocker_reason: 'Dependency said "no"',
          failure_detail: 'Parser refused raw curl JSON',
        },
      },
    ]);
  });
});

describe('AgentHqApiClient project file helpers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('lists, reads, histories, and deletes project files through typed REST paths', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      calls.push({ method, url });
      if (url.endsWith('/api/v1/projects/86/files') && method === 'GET') {
        return jsonResponse([
          { id: 5, filename: 'stored.txt', original_name: 'notes.txt', mime_type: 'text/plain', size_bytes: 11, uploaded_by: 'cinder' },
        ]);
      }
      if (url.endsWith('/api/v1/projects/86/files/5') && method === 'GET') {
        return jsonResponse({ id: 5, filename: 'stored.txt', original_name: 'notes.txt', mime_type: 'text/plain', size_bytes: 11, uploaded_by: 'cinder', updated_by: 'forge', current_version: 2 });
      }
      if (url.endsWith('/api/v1/projects/86/files/5/versions') && method === 'GET') {
        return jsonResponse([
          { id: 9, tenant_id: 1, project_id: 86, file_id: 5, version_number: 2, filename: 'stored-v2.txt', original_name: 'notes.txt', mime_type: 'text/plain', size_bytes: 12, created_by: 'forge', change_source: 'api_replace' },
          { id: 8, tenant_id: 1, project_id: 86, file_id: 5, version_number: 1, filename: 'stored.txt', original_name: 'notes.txt', mime_type: 'text/plain', size_bytes: 11, created_by: 'cinder', change_source: 'api_upload' },
        ]);
      }
      if (url.endsWith('/api/v1/projects/86/files/5') && method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: `Unexpected request: ${method} ${url}` }),
      } as Response;
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test', 'ahq_mcp_test');

    await expect(client.listProjectFiles(86)).resolves.toEqual([
      expect.objectContaining({ id: 5, original_name: 'notes.txt', mime_type: 'text/plain' }),
    ]);
    await expect(client.getProjectFile(86, 5)).resolves.toMatchObject({ id: 5, original_name: 'notes.txt', updated_by: 'forge', current_version: 2 });
    await expect(client.listProjectFileVersions(86, 5)).resolves.toEqual([
      expect.objectContaining({ version_number: 2, created_by: 'forge', change_source: 'api_replace' }),
      expect.objectContaining({ version_number: 1, created_by: 'cinder', change_source: 'api_upload' }),
    ]);
    await expect(client.deleteProjectFile(86, 5)).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      { method: 'GET', url: 'http://agent-hq.test/api/v1/projects/86/files' },
      { method: 'GET', url: 'http://agent-hq.test/api/v1/projects/86/files/5' },
      { method: 'GET', url: 'http://agent-hq.test/api/v1/projects/86/files/5/versions' },
      { method: 'DELETE', url: 'http://agent-hq.test/api/v1/projects/86/files/5' },
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer ahq_mcp_test',
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
    });
  });

  it('uploads project files by building multipart/form-data from base64 input', async () => {
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://agent-hq.test/api/v1/projects/86/files');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer ahq_mcp_test',
        'x-agent-hq-mcp-client': 'agent-hq-mcp',
      });
      expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          id: 6,
          filename: 'stored.txt',
          original_name: 'notes.txt',
          mime_type: 'text/plain',
          size_bytes: 11,
          uploaded_by: 'cinder',
        }),
      } as Response;
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test', 'ahq_mcp_test');
    await expect(client.uploadProjectFile(86, {
      filename: 'notes.txt',
      content_base64: Buffer.from('hello world').toString('base64'),
      mime_type: 'text/plain',
      uploaded_by: 'cinder',
    })).resolves.toMatchObject({
      id: 6,
      original_name: 'notes.txt',
      mime_type: 'text/plain',
      uploaded_by: 'cinder',
    });
  });

  it('downloads project files as base64 with text for text-like content', async () => {
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      if (url.endsWith('/api/v1/projects/86/files/5') && method === 'GET') {
        return jsonResponse({ id: 5, filename: 'stored.txt', original_name: 'notes.txt', mime_type: 'text/plain', size_bytes: 11, uploaded_by: 'cinder' });
      }
      if (url.endsWith('/api/v1/projects/86/files/5/download') && method === 'GET') {
        const bytes = Buffer.from('hello world');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/plain' }),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: `Unexpected request: ${method} ${url}` }),
      } as Response;
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test', 'ahq_mcp_test');

    await expect(client.downloadProjectFile(86, 5)).resolves.toMatchObject({
      metadata: expect.objectContaining({ id: 5, original_name: 'notes.txt' }),
      content_base64: Buffer.from('hello world').toString('base64'),
      encoding: 'base64',
      text: 'hello world',
    });
  });

  it('replaces project files in place with versioned PUT semantics', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      calls.push({ method, url });
      if (method === 'PUT' && url.endsWith('/api/v1/projects/86/files/5')) {
        expect(init?.body).toBeInstanceOf(FormData);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            id: 5,
            filename: 'replacement.txt',
            original_name: 'replacement.txt',
            mime_type: 'text/plain',
            size_bytes: 12,
            uploaded_by: 'cinder',
            updated_by: 'cinder',
            current_version: 2,
          }),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: `Unexpected request: ${method} ${url}` }),
      } as Response;
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test', 'ahq_mcp_test');
    await expect(client.replaceProjectFile(86, 5, {
      filename: 'replacement.txt',
      content_base64: Buffer.from('replacement').toString('base64'),
      mime_type: 'text/plain',
      uploaded_by: 'cinder',
    })).resolves.toMatchObject({
      id: 5,
      original_name: 'replacement.txt',
      updated_by: 'cinder',
      current_version: 2,
    });

    expect(calls).toEqual([
      { method: 'PUT', url: 'http://agent-hq.test/api/v1/projects/86/files/5' },
    ]);
  });
});

describe('AgentHqApiClient admin MCP CRUD endpoints', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('passes tenant-selectable task routing rule filters through typed CRUD calls', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');
    const scope = { tenant_id: 4, project_id: 1, sprint_type: 'dev', sprint_id: 57, scope: 'sprint_override', status: 'ready', task_type: 'backend' };

    await client.listRoutingRules(scope);
    await client.getRoutingRule(9, scope);
    await client.createRoutingRule({ ...scope, agent_id: 7, dry_run: true });
    await client.updateRoutingRule(9, { tenant_id: 4, status: 'review', dry_run: true });
    await client.deleteRoutingRule(9, { ...scope, dry_run: true });

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET http://agent-hq.test/api/v1/routing/rules?tenant_id=4&project_id=1&sprint_type=dev&sprint_id=57&scope=sprint_override&status=ready&task_type=backend',
      'GET http://agent-hq.test/api/v1/routing/rules/9?tenant_id=4&project_id=1&sprint_type=dev&sprint_id=57&scope=sprint_override&status=ready&task_type=backend',
      'POST http://agent-hq.test/api/v1/routing/rules?tenant_id=4',
      'PUT http://agent-hq.test/api/v1/routing/rules/9?tenant_id=4',
      'DELETE http://agent-hq.test/api/v1/routing/rules/9?tenant_id=4&project_id=1&sprint_type=dev&sprint_id=57&scope=sprint_override&status=ready&task_type=backend&dry_run=true',
    ]);
    expect(calls[2].body).toEqual({ project_id: 1, sprint_type: 'dev', sprint_id: 57, scope: 'sprint_override', status: 'ready', task_type: 'backend', agent_id: 7, dry_run: true });
    expect(calls[3].body).toEqual({ status: 'review', dry_run: true });
  });

  it('exposes assignment rule CRUD aliases while preserving tenant selector behavior', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');
    const scope = { tenant_id: 4, project_id: 1, sprint_type: 'dev', sprint_id: 57, scope: 'sprint_override', status: 'ready', task_type: 'backend' };

    await client.listAssignmentRules(scope);
    await client.getAssignmentRule(9, scope);
    await client.createAssignmentRule({ ...scope, agent_id: 7, dry_run: true });
    await client.updateAssignmentRule(9, { tenant_id: 4, status: 'review', dry_run: true });
    await client.deleteAssignmentRule(9, { ...scope, dry_run: true });

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET http://agent-hq.test/api/v1/routing/assignment-rules?tenant_id=4&project_id=1&sprint_type=dev&sprint_id=57&scope=sprint_override&status=ready&task_type=backend',
      'GET http://agent-hq.test/api/v1/routing/assignment-rules/9?tenant_id=4&project_id=1&sprint_type=dev&sprint_id=57&scope=sprint_override&status=ready&task_type=backend',
      'POST http://agent-hq.test/api/v1/routing/assignment-rules?tenant_id=4',
      'PUT http://agent-hq.test/api/v1/routing/assignment-rules/9?tenant_id=4',
      'DELETE http://agent-hq.test/api/v1/routing/assignment-rules/9?tenant_id=4&project_id=1&sprint_type=dev&sprint_id=57&scope=sprint_override&status=ready&task_type=backend&dry_run=true',
    ]);
    expect(calls[2].body).toEqual({ project_id: 1, sprint_type: 'dev', sprint_id: 57, scope: 'sprint_override', status: 'ready', task_type: 'backend', agent_id: 7, dry_run: true });
    expect(calls[3].body).toEqual({ status: 'review', dry_run: true });
  });

  it('passes tenant selectors through workflow event mapping CRUD calls', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.listWorkflowEventMappings({ tenant_id: 4, project_id: 1, source: 'agent_hq_runtime', event_name: 'agent_started', task_type: 'backend' });
    await client.getWorkflowEventMapping(3, { tenant_id: 4 });
    await client.createWorkflowEventMapping({ tenant_id: 4, event_name: 'agent_started', dry_run: true });
    await client.updateWorkflowEventMapping(3, { tenant_id: 4, priority: 10, dry_run: true });
    await client.deleteWorkflowEventMapping(3, { tenant_id: 4, dry_run: true });

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET http://agent-hq.test/api/v1/routing/workflow-event-mappings?tenant_id=4&project_id=1&source=agent_hq_runtime&event_name=agent_started&task_type=backend',
      'GET http://agent-hq.test/api/v1/routing/workflow-event-mappings/3?tenant_id=4',
      'POST http://agent-hq.test/api/v1/routing/workflow-event-mappings?tenant_id=4',
      'PUT http://agent-hq.test/api/v1/routing/workflow-event-mappings/3?tenant_id=4',
      'DELETE http://agent-hq.test/api/v1/routing/workflow-event-mappings/3?tenant_id=4&dry_run=true',
    ]);
    expect(calls[2].body).toEqual({ event_name: 'agent_started', dry_run: true });
    expect(calls[3].body).toEqual({ priority: 10, dry_run: true });
  });

  it('passes tenant selectors through transitions and gate requirement admin calls', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.listRoutingTransitions({ tenant_id: 4, project_id: 1, sprint_id: 57, sprint_type: 'dev' });
    await client.getRoutingTransition(12, { tenant_id: 4, project_id: 1, sprint_id: 57 });
    await client.createRoutingTransition({ tenant_id: 4, project_id: 1, sprint_id: 57, from_status: 'ready', outcome: 'start', to_status: 'in_progress', dry_run: true });
    await client.updateRoutingTransition(12, { tenant_id: 4, enabled: false, dry_run: true });
    await client.deleteRoutingTransition(12, { tenant_id: 4, project_id: 1, sprint_id: 57, dry_run: true });
    await client.listTransitionRequirements({ tenant_id: 4, project_id: 1, sprint_id: 57, sprint_type: 'dev', outcome: 'completed_for_review' });
    await client.createTransitionRequirement({ tenant_id: 4, project_id: 1, sprint_id: 57, outcome: 'completed_for_review', field_name: 'review_commit', dry_run: true });
    await client.updateTransitionRequirement(17, { tenant_id: 4, severity: 'warn', dry_run: true });
    await client.deleteTransitionRequirement(17, { tenant_id: 4, project_id: 1, sprint_id: 57, dry_run: true });

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET http://agent-hq.test/api/v1/routing/transitions?tenant_id=4&sprint_id=57&project_id=1&sprint_type=dev',
      'GET http://agent-hq.test/api/v1/routing/transitions/12?tenant_id=4&sprint_id=57&project_id=1',
      'POST http://agent-hq.test/api/v1/routing/transitions?tenant_id=4',
      'PUT http://agent-hq.test/api/v1/routing/transitions/12?tenant_id=4',
      'DELETE http://agent-hq.test/api/v1/routing/transitions/12?tenant_id=4&sprint_id=57&project_id=1&dry_run=true',
      'GET http://agent-hq.test/api/v1/routing/transition-requirements?tenant_id=4&project_id=1&sprint_id=57&sprint_type=dev&outcome=completed_for_review',
      'POST http://agent-hq.test/api/v1/routing/transition-requirements?tenant_id=4',
      'PUT http://agent-hq.test/api/v1/routing/transition-requirements/17?tenant_id=4',
      'DELETE http://agent-hq.test/api/v1/routing/transition-requirements/17?tenant_id=4&project_id=1&sprint_id=57&dry_run=true',
    ]);
    expect(calls[2].body).toEqual({ project_id: 1, sprint_id: 57, from_status: 'ready', outcome: 'start', to_status: 'in_progress', dry_run: true });
    expect(calls[3].body).toEqual({ enabled: false, dry_run: true });
    expect(calls[6].body).toEqual({ project_id: 1, sprint_id: 57, outcome: 'completed_for_review', field_name: 'review_commit', dry_run: true });
    expect(calls[7].body).toEqual({ severity: 'warn', dry_run: true });
  });

  it('uses typed read/update paths for agent dispatch contracts and helper reads', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.getAgentDispatchContract({ sprint_type: 'dev' });
    await client.updateAgentDispatchContract({ sprint_type: 'dev', content: 'contract' });
    await client.getWorkflowConfig();
    await client.getWorkflowMetadata({ tenant_id: 4, sprint_type: 'dev', task_type: 'backend' });
    await client.listTransitionRequirementFields({ tenant_id: 4, sprint_type: 'dev', task_type: 'backend' });

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET http://agent-hq.test/api/v1/routing/agent-contract?sprint_type=dev',
      'PUT http://agent-hq.test/api/v1/routing/agent-contract',
      'GET http://agent-hq.test/api/v1/sprints/config',
      'GET http://agent-hq.test/api/v1/sprints/workflow-metadata?tenant_id=4&sprint_type=dev&task_type=backend',
      'GET http://agent-hq.test/api/v1/routing/transition-requirement-fields?tenant_id=4&sprint_type=dev&task_type=backend',
    ]);
    expect(calls[1].body).toEqual({ sprint_type: 'dev', content: 'contract' });
  });

  it('passes super-admin tenant selectors on workflow metadata definition reads', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.listSprintTypes({ tenant_id: 4 });
    await client.listSprintTypeTaskTypes('dev', { tenant_id: 4 });
    await client.listSprintTypeStatuses('dev', { tenant_id: 4 });
    await client.getSprintTypeStatus('dev', 'review', { tenant_id: 4 });
    await client.listSprintTypeOutcomes('dev', { tenant_id: 4 });
    await client.getSprintTypeOutcome('dev', 4, { tenant_id: 4 });
    await client.listSprintTypeRelationshipTypes('dev', { tenant_id: 4 });
    await client.getSprintTypeRelationshipType('dev', 5, { tenant_id: 4 });
    await client.listTaskFieldSchemas('dev', { tenant_id: 4 });
    await client.getTaskFieldSchema('dev', 6, { tenant_id: 4 });

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET http://agent-hq.test/api/v1/sprints/types/list?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/task-types?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/statuses?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/statuses/review?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/outcomes?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/outcomes/4?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/relationship-types?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/relationship-types/5?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/field-schemas?tenant_id=4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/field-schemas/6?tenant_id=4',
    ]);
  });

  it('uses typed CRUD paths for sprint definition statuses, outcomes, and relationship types', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');

    await client.listSprintTypeStatuses('dev');
    await client.getSprintTypeStatus('dev', 'review');
    await client.createSprintTypeStatus('dev', { name: 'triage', label: 'Triage' });
    await client.updateSprintTypeStatus('dev', 'triage', { label: 'Triage Updated' });
    await client.deleteSprintTypeStatus('dev', 'triage');
    await client.listSprintTypeOutcomes('dev');
    await client.getSprintTypeOutcome('dev', 4);
    await client.createSprintTypeOutcome('dev', { outcome_key: 'ship_it', label: 'Ship It' });
    await client.updateSprintTypeOutcome('dev', 4, { label: 'Ship It Updated' });
    await client.deleteSprintTypeOutcome('dev', 4);
    await client.listSprintTypeRelationshipTypes('dev');
    await client.getSprintTypeRelationshipType('dev', 5);
    await client.createSprintTypeRelationshipType('dev', { key: 'blocks', label: 'Blocks' });
    await client.updateSprintTypeRelationshipType('dev', 5, { label: 'Blocks Updated' });
    await client.deleteSprintTypeRelationshipType('dev', 5);

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET http://agent-hq.test/api/v1/sprints/types/dev/statuses',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/statuses/review',
      'POST http://agent-hq.test/api/v1/sprints/types/dev/statuses',
      'PUT http://agent-hq.test/api/v1/sprints/types/dev/statuses/triage',
      'DELETE http://agent-hq.test/api/v1/sprints/types/dev/statuses/triage',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/outcomes',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/outcomes/4',
      'POST http://agent-hq.test/api/v1/sprints/types/dev/outcomes',
      'PUT http://agent-hq.test/api/v1/sprints/types/dev/outcomes/4',
      'DELETE http://agent-hq.test/api/v1/sprints/types/dev/outcomes/4',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/relationship-types',
      'GET http://agent-hq.test/api/v1/sprints/types/dev/relationship-types/5',
      'POST http://agent-hq.test/api/v1/sprints/types/dev/relationship-types',
      'PUT http://agent-hq.test/api/v1/sprints/types/dev/relationship-types/5',
      'DELETE http://agent-hq.test/api/v1/sprints/types/dev/relationship-types/5',
    ]);
  });
});

describe('AgentHqApiClient.getTaskContext', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('calls the task context endpoint with mode and explicit filters', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: String(init?.method ?? 'GET'), url: String(input) });
      return jsonResponse({ task_id: 448, mode: 'summary', server_summary: 'ok' });
    });
    (global as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new AgentHqApiClient('http://agent-hq.test');
    const result = await client.getTaskContext(448, 'summary', {
      includeNotes: true,
      includeHistory: false,
      recentNotesLimit: 4,
      sinceNoteId: 9001,
      sinceHistoryId: 8001,
      sinceTimestamp: '2026-05-09T18:20:00Z',
    });

    expect(result).toMatchObject({ task_id: 448, mode: 'summary' });
    expect(calls).toEqual([
      {
        method: 'GET',
        url: 'http://agent-hq.test/api/v1/tasks/448/context?mode=summary&includeNotes=true&includeHistory=false&recentNotesLimit=4&sinceNoteId=9001&sinceHistoryId=8001&sinceTimestamp=2026-05-09T18%3A20%3A00Z',
      },
    ]);
  });
});
