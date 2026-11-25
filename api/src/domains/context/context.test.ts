import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { renderContextBundle } from '../../services/dispatch/prompt/contextBundle';
import {
  clearContextBundleStoreAvailabilityCache,
  persistDispatchContextBundle,
} from '../../services/dispatch/contextBundleStore';
import { recordRunMcpToolSnapshots } from '../../runtimes/mcpToolSnapshots';
import type { RuntimeBoundaryV1 } from '../../runtimes/runtimeBoundary';
import { ContextPublishError, publishContextChanges, withToolAllowlist } from './publish';
import {
  agentContextSources,
  contextSourceHash,
  listContextRuns,
  runMcpTools,
  taskContextSources,
} from './workspace';

const SKILL = '---\nname: proposal-rules\ndescription: How to write proposals\n---\n\n# Rules\n';

async function seed(): Promise<void> {
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Agent HQ', 'default', 1) ON CONFLICT (id) DO NOTHING`);
  await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (90, 1, 'Agency', '', 'Project facts.')`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, goal, workflow_type, status)
                VALUES (50, 1, 90, 'Lead gen', 'Win work.', 'generic', 'active')`);
  await db.run(`INSERT INTO agents (id, tenant_id, name, role, session_key, workspace_path, status, job_title, runtime_type, job_instructions, skill_names, instructions_version)
                VALUES (9, 1, 'Casper', 'Reviewer', 'agent:casper:test', '/tmp/casper', 'idle', 'Reviewer', 'claude-code', 'Review proposals.', '["proposal-rules"]', 3)`);
  await db.run(`INSERT INTO skills (tenant_id, name, description, content, source) VALUES (1, 'proposal-rules', '', ?, 'atlas'), (1, 'create-task', 'Create tasks', '# Create', 'atlas')`, SKILL);
  await db.run(`INSERT INTO mcp_servers (id, tenant_id, name, slug, command) VALUES (31, 1, 'Agency CRM', 'agency-crm', 'node')`);
  await db.run(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled) VALUES (9, 31, '{"allowed_tools":["crm_get_proposal"]}', 1)`);
  await db.run(`INSERT INTO recurring_task_series (id, tenant_id, project_id, workflow_id, title_template, description_template, task_type, story_points, status_on_create, schedule_expression, timezone)
                VALUES (4, 1, 90, 50, 'Sweep', 'Sweep the queue.', 'review', 1, 'ready', '0 * * * *', 'UTC')`);
  await db.run(`INSERT INTO tasks (id, tenant_id, title, description, status, priority, project_id, workflow_id, task_type, custom_fields_json, recurring_series_id)
                VALUES (900, 1, 'Review proposal', 'Check it.', 'review', 'high', 90, 50, 'review', '{}', 4)`);
  await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key, dispatched_at)
                VALUES (800, 1, 9, 900, 'done', 'run:800', '2026-11-24 12:00:00')`);
  clearContextBundleStoreAvailabilityCache(db);
  await persistDispatchContextBundle(db, {
    tenantId: 1, instanceId: 800, durableRunId: 'run-800', taskId: 900, agentId: 9,
    bundle: renderContextBundle([{
      kind: 'job_instructions', label: 'Job Instructions', text: 'Review proposals.',
      source: { type: 'job', label: 'Reviewer', id: 9 },
    }]),
  });
}

function boundary(): RuntimeBoundaryV1 {
  return {
    tools: {
      builtIn: [], requiredLifecycleTools: [], skills: [], registryTools: [],
      mcpServers: [
        { name: 'agency-crm__agent-9', configFingerprint: 'crm-config-v1', requiredToolNames: ['crm_get_proposal'] },
        { name: 'agent-hq-tools__agent-9', configFingerprint: 'bridge-config-v1', requiredToolNames: [] },
      ],
    },
  } as unknown as RuntimeBoundaryV1;
}

const CRM_TOOLS = [
  { name: 'crm_get_proposal', description: 'Read a proposal', inputSchema: { type: 'object' } },
  { name: 'crm_reject', description: 'Reject a proposal', inputSchema: { type: 'object' } },
];

describe('Context page read model and publish', () => {
  beforeEach(async () => {
    await setupTestDb();
    await seed();
  });
  afterEach(async () => {
    await teardownTestDb();
  });

  it('records each run server once per config and tool list, probing only unknown servers', async () => {
    const db = getDb();
    const probe = jest.fn(async () => ({
      serverName: 'agent-hq-tools__agent-9', ok: true, toolNames: ['send_report'], durationMs: 1,
      tools: [{ name: 'send_report', description: 'Send it' }],
    }));
    const input = {
      db, tenantId: 1, instanceId: 800, boundary: boundary(),
      preflightResults: [{ serverName: 'agency-crm__agent-9', ok: true, toolNames: CRM_TOOLS.map((t) => t.name), tools: CRM_TOOLS, durationMs: 1 }],
      servers: { 'agent-hq-tools__agent-9': { command: 'node' } },
      probe,
    };
    await recordRunMcpToolSnapshots(input);
    await recordRunMcpToolSnapshots(input);

    // The bridge had no preflight; it was probed once, then reused while fresh.
    expect(probe).toHaveBeenCalledTimes(1);
    const snapshots = await db.all('SELECT server_name, mcp_server_id, tool_count FROM agents.mcp_tool_snapshots ORDER BY server_name');
    expect(snapshots).toEqual([
      { server_name: 'agency-crm__agent-9', mcp_server_id: 31, tool_count: 2 },
      { server_name: 'agent-hq-tools__agent-9', mcp_server_id: null, tool_count: 1 },
    ]);
    const tools = await runMcpTools(db, 1, 800);
    expect(tools.map((server) => [server.serverName, server.tools.map((tool) => tool.name)])).toEqual([
      ['agency-crm__agent-9', ['crm_get_proposal', 'crm_reject']],
      ['agent-hq-tools__agent-9', ['send_report']],
    ]);
    expect(tools[0].definitionChars).toBe(tools[0].tools.reduce((sum, tool) => sum + tool.chars, 0));
  });

  it('describes the agent sources with hashes, skill delivery and recorded tools', async () => {
    const db = getDb();
    await recordRunMcpToolSnapshots({
      db, tenantId: 1, instanceId: 800, boundary: boundary(),
      preflightResults: [{ serverName: 'agency-crm__agent-9', ok: true, toolNames: [], tools: CRM_TOOLS, durationMs: 1 }],
      servers: {},
    });
    const sources = await agentContextSources(db, 1, 9);

    expect(sources.agent.jobInstructions).toEqual({ value: 'Review proposals.', hash: contextSourceHash('Review proposals.'), chars: 17 });
    expect(sources.skills).toEqual([expect.objectContaining({
      name: 'proposal-rules', description: 'How to write proposals', source: 'agent', delivery: 'claude_code_plugin',
    })]);
    expect(sources.tools.builtIn).toContain('Skill');
    expect(sources.tools.mcpServers).toEqual([expect.objectContaining({
      slug: 'agency-crm', editable: true, unrestricted: false,
      allowlist: { value: ['crm_get_proposal'], hash: contextSourceHash(['crm_get_proposal']) },
      recorded: expect.objectContaining({ toolCount: 2 }),
    })]);
    expect(sources.workflows).toEqual([expect.objectContaining({ id: 50, goal: expect.objectContaining({ value: 'Win work.' }), taskTypes: ['review'] })]);
    expect(sources.projects).toEqual([expect.objectContaining({ id: 90, contextMd: expect.objectContaining({ value: 'Project facts.' }) })]);

    const task = await taskContextSources(db, 1, 900);
    expect(task.series).toEqual(expect.objectContaining({ id: 4, descriptionTemplate: expect.objectContaining({ value: 'Sweep the queue.' }) }));
    expect(await listContextRuns(db, 1, { agentId: 9, workflowId: 50, taskType: 'review' })).toEqual([
      expect.objectContaining({ instanceId: 800, taskId: 900, agentName: 'Casper' }),
    ]);
    expect(await listContextRuns(db, 1, { taskType: 'other' })).toEqual([]);
    expect(await listContextRuns(db, 1, { projectId: 90, agentId: 9 })).toHaveLength(1);
    expect(await listContextRuns(db, 1, { projectId: 91, agentId: 9 })).toEqual([]);
  });

  it('publishes every staged edit together and re-approves the edited agent', async () => {
    const db = getDb();
    const result = await publishContextChanges(db, 1, [
      { kind: 'job_instructions', agent_id: 9, base_hash: contextSourceHash('Review proposals.'), value: 'Review proposals carefully.' },
      { kind: 'agent_skills', agent_id: 9, base_hash: contextSourceHash(['proposal-rules']), value: ['proposal-rules', 'create-task'] },
      { kind: 'mcp_allowlist', agent_id: 9, mcp_server_id: 31, base_hash: contextSourceHash(['crm_get_proposal']), value: ['crm_get_proposal', 'crm_reject'] },
      { kind: 'workflow_goal', workflow_id: 50, base_hash: contextSourceHash('Win work.'), value: 'Win good work.' },
      { kind: 'project_context', project_id: 90, base_hash: contextSourceHash('Project facts.'), value: 'New facts.' },
      { kind: 'task_description', task_id: 900, base_hash: contextSourceHash('Check it.'), value: 'Check it twice.' },
      { kind: 'series_template', series_id: 4, base_hash: contextSourceHash('Sweep the queue.'), value: 'Sweep newest first.' },
    ], 'operator');

    expect(result.applied).toHaveLength(7);
    expect(result.republished).toEqual([expect.objectContaining({ agentId: 9 })]);
    const agent = await db.get<Record<string, any>>('SELECT job_instructions, skill_names, instructions_version FROM agents WHERE id = 9');
    expect(agent).toEqual({ job_instructions: 'Review proposals carefully.', skill_names: '["create-task","proposal-rules"]', instructions_version: 4 });
    const binding = await db.get<Record<string, any>>(
      `SELECT b.revision_id, r.published_at FROM execution_bindings b JOIN executable_revisions r ON r.id = b.revision_id
       WHERE b.subject_kind = 'agent' AND b.subject_id = 9 AND b.resource_kind = 'agent_runtime'`,
    );
    expect(binding?.revision_id).toBe(result.republished[0].revisionId);
    expect(binding?.published_at).toBeTruthy();
    expect((await db.get<Record<string, any>>('SELECT description_template FROM recurring_task_series WHERE id = 4'))?.description_template).toBe('Sweep newest first.');
    const sources = await agentContextSources(db, 1, 9);
    expect(sources.tools.mcpServers[0].allowlist.value).toEqual(['crm_get_proposal', 'crm_reject']);
    // Written to the field launch reads, not a second field it would ignore.
    expect(JSON.parse(String((await db.get<Record<string, any>>('SELECT overrides FROM agent_mcp_assignments WHERE agent_id = 9'))?.overrides)))
      .toEqual({ allowed_tools: ['crm_get_proposal', 'crm_reject'] });
  });

  it('keeps allowlist edits on the field launch reads, and clears every field for unrestricted', () => {
    expect(withToolAllowlist({ allowedTools: ['a'], tool_allowlist: ['x'], env: 1 }, ['b', 'a'])).toEqual({ allowedTools: ['a', 'b'], tool_allowlist: ['x'], env: 1 });
    expect(withToolAllowlist({ toolFilter: { include: ['a'], mode: 'x' } }, ['c'])).toEqual({ toolFilter: { include: ['c'], mode: 'x' } });
    expect(withToolAllowlist({}, ['c'])).toEqual({ tool_allowlist: ['c'] });
    expect(withToolAllowlist({ allowed_tools: ['a'], toolAllowlist: ['b'], toolFilter: { include: ['c'] } }, [])).toEqual({ toolFilter: {} });
  });

  it('writes nothing when any staged source changed since it was read', async () => {
    const db = getDb();
    await db.run(`UPDATE workflows SET goal = 'Someone else edited this.' WHERE id = 50`);
    await expect(publishContextChanges(db, 1, [
      { kind: 'job_instructions', agent_id: 9, base_hash: contextSourceHash('Review proposals.'), value: 'Changed.' },
      { kind: 'workflow_goal', workflow_id: 50, base_hash: contextSourceHash('Win work.'), value: 'Mine.' },
    ], 'operator')).rejects.toMatchObject({
      status: 409,
      detail: { conflicts: [expect.objectContaining({ target: 'workflow_goal:workflow:50' })] },
    });
    expect((await db.get<Record<string, any>>('SELECT job_instructions FROM agents WHERE id = 9'))?.job_instructions).toBe('Review proposals.');
    expect(await db.get(`SELECT id FROM executable_revisions WHERE resource_kind = 'agent_runtime'`)).toBeUndefined();
  });

  it('rejects unknown skills and duplicate targets without writing', async () => {
    const db = getDb();
    await expect(publishContextChanges(db, 1, [
      { kind: 'agent_skills', agent_id: 9, base_hash: contextSourceHash(['proposal-rules']), value: ['no-such-skill'] },
    ], 'operator')).rejects.toBeInstanceOf(ContextPublishError);
    await expect(publishContextChanges(db, 1, [
      { kind: 'workflow_goal', workflow_id: 50, base_hash: contextSourceHash('Win work.'), value: 'a' },
      { kind: 'workflow_goal', workflow_id: 50, base_hash: contextSourceHash('Win work.'), value: 'b' },
    ], 'operator')).rejects.toMatchObject({ status: 400, code: 'duplicate_change' });
    expect((await db.get<Record<string, any>>('SELECT skill_names FROM agents WHERE id = 9'))?.skill_names).toBe('["proposal-rules"]');
  });
});
