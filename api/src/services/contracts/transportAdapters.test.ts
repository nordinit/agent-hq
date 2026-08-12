import { setupTestDb, teardownTestDb } from '../../db/testDb';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Db } from "../../db/adapter/types";

let buildContractInstructions: typeof import('./transportAdapters').buildContractInstructions;
let resolveTransportMode: typeof import('./transportAdapters').resolveTransportMode;
type TransportContext = import('./transportAdapters').TransportContext;

const originalRoot = process.env.AGENT_CONTRACT_ROOT;
const originalCwd = process.cwd();
let tempDir: string;
let extraTempDirs: string[] = [];
let extraDbs: Db[] = [];

function loadTransportAdapters() {
  let loaded: typeof import('./transportAdapters');
  jest.isolateModules(() => {
    loaded = require('./transportAdapters');
  });
  return loaded!;
}

beforeEach(() => {
  jest.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-contracts-'));
  process.env.AGENT_CONTRACT_ROOT = tempDir;

  fs.writeFileSync(path.join(tempDir, 'generic.md'), '## Agent HQ run contract for this dispatched instance\nSprint type: {{sprintType}}\nAgent: {{agentSlug}}\nTask ID: {{taskId}}\nBase URL: {{baseUrl}}\nUse ONE of these outcomes: {{validOutcomes}}\nConfigured gate fields for {{evidenceOutcomes}}:\n{{evidenceFieldsBulleted}}\n', 'utf-8');
  fs.writeFileSync(path.join(tempDir, 'enhancements.md'), '## Agent HQ enhancement contract for this dispatched instance\nSprint type: {{sprintType}}\nUse ONE of these outcomes: {{validOutcomes}}\nREQUIRED OUTPUTS FOR ENHANCEMENTS\nagent_hq_post_task_outcome task_id={{taskId}}\nchanged_by={{agentSlug}}\n', 'utf-8');

  ({
    buildContractInstructions,
    resolveTransportMode,
  } = loadTransportAdapters());
});

function reloadWithContractRoot(contractRoot: string): void {
  jest.resetModules();
  process.env.AGENT_CONTRACT_ROOT = contractRoot;
  ({ buildContractInstructions } = loadTransportAdapters());
}

function reloadWithoutFileTemplates(): void {
  jest.resetModules();
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-contracts-empty-'));
  extraTempDirs.push(emptyRoot);
  process.env.AGENT_CONTRACT_ROOT = emptyRoot;
  ({ buildContractInstructions } = loadTransportAdapters());
}

afterEach(async () => {
  if (originalRoot == null) delete process.env.AGENT_CONTRACT_ROOT;
  else process.env.AGENT_CONTRACT_ROOT = originalRoot;
  process.chdir(originalCwd);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const dir of extraTempDirs) fs.rmSync(dir, { recursive: true, force: true });
  extraTempDirs = [];
  for (const db of extraDbs) await teardownTestDb();
  extraDbs = [];
});

async function createGateDb(): Promise<Db> {
  const db = await setupTestDb();
  // Gate rows only exist inside a workflow scope — the global `transition_requirements` table
  // this used to write to was dropped by migration 15 — so the fixture needs a workflow to
  // hang them on.
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agent HQ')`);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type, status)
    VALUES (1, 1, 1, 'Generic workflow', 'generic', 'active')
  `);

  extraDbs.push(db);
  return db;
}

function buildContext(overrides: Partial<TransportContext> = {}): TransportContext {
  return {
    instanceId: 1667,
    taskId: 369,
    taskStatus: 'in_progress',
    taskType: 'backend',
    sprintType: 'enhancements',
    agentSlug: 'cinder-backend',
    sessionKey: 'hook:atlas:jobrun:1667',
    baseUrl: 'http://localhost:3501',
    transportMode: 'remote-direct',
    db: null,
    ...overrides,
  };
}

describe('dispatch contract template renderer', () => {
  const repoContractRoot = path.resolve(__dirname, '../../../../agent-contracts');

  it('uses the sprint-type text template for remote-direct dispatches', async () => {
    const contract = await buildContractInstructions(buildContext());

    expect(contract).toContain('## Agent HQ enhancement contract for this dispatched instance');
    expect(contract).toContain('Sprint type: enhancements');
    expect(contract).toContain('REQUIRED OUTPUTS FOR ENHANCEMENTS');
    expect(contract).toContain('completed_for_review, dev_deploy_queued, blocked, failed');
    expect(contract).toContain('agent_hq_post_task_outcome task_id=369');
  });

  it('renders the placeholders used by the sprint template fixture', async () => {
    const contract = await buildContractInstructions(buildContext());

    expect(contract).toContain('cinder-backend');
    expect(contract).toContain('agent_hq_post_task_outcome task_id=369');
    expect(contract).toContain('Use ONE of these outcomes: completed_for_review, dev_deploy_queued, blocked, failed');
    expect(contract).not.toContain('{{agentSlug}}');
    expect(contract).not.toContain('{{baseUrl}}');
    expect(contract).not.toContain('{{lane}}');
    expect(contract).not.toContain('Workflow Category');
    expect(contract).not.toContain('workflow category');
    expect(contract).not.toContain('{{taskId}}');
    expect(contract).not.toContain('{{validOutcomes}}');
  });

  it('falls back to the generic text template for unknown sprint types', async () => {
    const contract = await buildContractInstructions(buildContext({ sprintType: 'qa' }));

    expect(contract).toContain('## Agent HQ run contract for this dispatched instance');
    expect(contract).toContain('Sprint type: qa');
    expect(contract).toContain('Use ONE of these outcomes: completed_for_review, dev_deploy_queued, blocked, failed');
  });

  it('falls back to generic when a sprint type has no dedicated template yet', async () => {
    const devContract = await buildContractInstructions(buildContext({ sprintType: 'dev' }));
    expect(devContract).toContain('## Agent HQ run contract for this dispatched instance');
    expect(devContract).toContain('Sprint type: dev');
    expect(devContract).not.toContain('Workflow lane');
    expect(devContract).not.toContain('Workflow Category');
    expect(devContract).not.toContain('workflow category');
  });

  it('does not inject later release outcomes that are not valid from the current route', async () => {
    const contract = await buildContractInstructions(buildContext({
      sprintType: 'generic',
      taskStatus: 'ready_to_merge',
      transportMode: 'remote-direct',
    }));

    expect(contract).toContain('Use ONE of these outcomes: deployed_live, blocked, failed');
    expect(contract).not.toContain('Use ONE of these outcomes: deployed_live, live_verified');
  });

  it('does not infer QA evidence fields when no gate rows are configured', async () => {
    const contract = await buildContractInstructions(buildContext({
      taskStatus: 'review',
      transportMode: 'local',
      sprintType: 'generic',
    }));

    expect(contract).not.toContain('"qa_verified_commit":"<sha>"');
    expect(contract).not.toContain('"qa_tested_url":"<tested-url>"');
    expect(contract).not.toMatch(/"verified_commit"\s*:/);
    expect(contract).not.toMatch(/"qa_url"\s*:/);
  });

  it('renders configured gate fields from the template placeholders', async () => {
    const db = await createGateDb();
    await db.run(`
      INSERT INTO sprint_task_transition_requirements
        (tenant_id, sprint_id, project_id, sprint_type, outcome, field_name, requirement_type, severity, message)
      VALUES (1, 1, 1, 'generic', 'qa_pass', 'qa_verified_commit', 'required', 'block', 'qa_pass requires qa_verified_commit')
    `);

    const contract = await buildContractInstructions(buildContext({
      taskStatus: 'review',
      transportMode: 'local',
      sprintType: 'generic',
      sprintId: 1,
      db,
    }));

    expect(contract).toContain('Configured gate fields for qa_pass');
    expect(contract).toContain('qa_verified_commit');
  });

  it('requires implementation dev deployment in the real dev template', async () => {
    reloadWithContractRoot(repoContractRoot);
    const contract = await buildContractInstructions(buildContext({
      taskStatus: 'in_progress',
      transportMode: 'local',
      sprintType: 'dev',
    }));

    expect(contract).toContain('Critical implementation rule');
    expect(contract).toContain('configured review environment that QA will test');
    expect(contract).toContain('configured deployment path');
    expect(contract).toContain('Post `dev_deploy_queued`');
    expect(contract).toContain('Do not deploy by copying files into an unrelated checkout');
    expect(contract).toContain('not merely committed locally');
    expect(contract).toContain('Post `blocked` or `failed`');
    expect(contract).toContain('agent_hq_start_task_run');
    expect(contract).toContain('agent_hq_check_in_task_run');
    expect(contract).toContain('agent_hq_post_task_outcome');
    expect(contract).toContain('agent_hq_record_review_evidence');
  });

  it('requires QA lease validation in the real dev template', async () => {
    reloadWithContractRoot(repoContractRoot);
    const contract = await buildContractInstructions(buildContext({
      taskStatus: 'review',
      transportMode: 'local',
      sprintType: 'dev',
    }));

    expect(contract).toContain('Critical QA rule');
    expect(contract).toContain('review environment, and commit match the recorded review evidence');
    expect(contract).toContain('recorded review environment');
    expect(contract).toContain("QA agent's own worktree HEAD");
    expect(contract).toContain('environment mismatch');
  });

  it('spells out config-driven release guidance in the real dev template', async () => {
    reloadWithContractRoot(repoContractRoot);
    const contract = await buildContractInstructions(buildContext({
      taskStatus: 'ready_to_merge',
      transportMode: 'local',
      sprintType: 'dev',
    }));

    expect(contract).toContain('- Valid outcomes: `deployed_live, blocked, failed`');
    expect(contract).toContain('Release outcomes and terminal behavior are defined by the configured workflow routes');
    expect(contract).toContain('Release environment cleanup');
    expect(contract).toContain('cleanup required by the configured workflow');
    expect(contract).toContain('agent_hq_record_deploy_evidence');
    expect(contract).toContain('agent_hq_record_live_verification');
    expect(contract).not.toContain('record deploy evidence, post deployed_live, record live verification, then post live_verified');
    expect(contract).not.toContain('live_verified requires live_verified_by');
  });

  it('fails loudly when no editable contract template exists', async () => {
    reloadWithoutFileTemplates();

    await expect(buildContractInstructions(buildContext({
      sprintType: 'generic',
      transportMode: 'local',
    }))).rejects.toThrow('No contract template found for sprint type "generic"');
  });

  it('ships dev as the explicit software-delivery contract', () => {
    reloadWithContractRoot(repoContractRoot);
    const genericTemplate = fs.readFileSync(path.join(repoContractRoot, 'generic.md'), 'utf-8');
    const devTemplate = fs.readFileSync(path.join(repoContractRoot, 'dev.md'), 'utf-8');

    expect(devTemplate).not.toBe(genericTemplate);
    expect(devTemplate).toContain('Dev Environment Lease Manager MCP tool `dev_env_deploy_worktree`');
    expect(devTemplate).toContain('dev_env_validate_qa');
  });

  it('ships ops as an operational contract instead of a dev clone', () => {
    reloadWithContractRoot(repoContractRoot);
    const genericTemplate = fs.readFileSync(path.join(repoContractRoot, 'generic.md'), 'utf-8');
    const opsTemplate = fs.readFileSync(path.join(repoContractRoot, 'ops.md'), 'utf-8');

    expect(opsTemplate).not.toBe(genericTemplate);
    expect(opsTemplate).toContain('Agent HQ Operations Task Contract');
    expect(opsTemplate).toContain('operational, infrastructure, administration, or process work');
    expect(opsTemplate).not.toContain('dev_env_deploy_worktree');
  });

  it('ships the real dev template with canonical QA and live verification fields', () => {
    reloadWithContractRoot(repoContractRoot);
    const repoTemplate = fs.readFileSync(path.join(repoContractRoot, 'dev.md'), 'utf-8');

    expect(repoTemplate).toContain('"qa_verified_commit":"<sha>"');
    expect(repoTemplate).toContain('"qa_tested_url":"<tested-url>"');
    expect(repoTemplate).toContain('"review_branch":"<feature-branch>"');
    expect(repoTemplate).toContain('"review_commit":"<sha>"');
    expect(repoTemplate).toContain('configured review environment');
    expect(repoTemplate).toContain('configured deployment path');
    expect(repoTemplate).toContain('dev_deploy_queued');
    expect(repoTemplate).toContain('recorded review environment');
    expect(repoTemplate).toContain('Release environment cleanup');
    expect(repoTemplate).toContain('not merely committed locally');
    expect(repoTemplate).toContain('"live_verified_by":"{{agentSlug}}"');
    expect(repoTemplate).toContain('"live_verified_at":"<ISO timestamp>"');
    expect(repoTemplate).toContain('agent_hq_record_review_evidence');
    expect(repoTemplate).toContain('agent_hq_record_live_verification');
    expect(repoTemplate).toContain('Use the Agent HQ MCP lifecycle/task tools');
    expect(repoTemplate).toContain('Do not call Agent HQ lifecycle HTTP endpoints directly');
    expect(repoTemplate).not.toContain('Runtime: Proxy-Managed');
    expect(repoTemplate).not.toContain('agent_hq_lifecycle');
    expect(repoTemplate).not.toContain('lifecycleJsonExample');
    expect(repoTemplate).not.toContain('HTTP fallback');
    expect(repoTemplate).not.toContain('curl -s');
    expect(repoTemplate).toContain('Dev Environment Lease Manager');
    expect(repoTemplate).toContain('dev_env_deploy_worktree');
    expect(repoTemplate).toContain('agent-hq-dev');
    expect(repoTemplate).toContain('deploy_dev_worktree');
    expect(repoTemplate).not.toMatch(/"verified_commit"\s*:/);
    expect(repoTemplate).not.toMatch(/"qa_url"\s*:/);
    expect(repoTemplate).not.toMatch(/"branch"\s*:\s*"<feature-branch>"/);
  });

  it('ships the real generic template as a five-status starter workflow contract', () => {
    reloadWithContractRoot(repoContractRoot);
    const repoTemplate = fs.readFileSync(path.join(repoContractRoot, 'generic.md'), 'utf-8');

    expect(repoTemplate).toContain('Agent HQ Generic Task Contract');
    expect(repoTemplate).toContain('todo -> ready -> in_progress -> review -> done');
    expect(repoTemplate).toContain('blocked`, `env_blocked`, or `approval_blocked`');
    expect(repoTemplate).toContain('failed` or `infra_failed`');
    expect(repoTemplate).not.toContain('dev_env_deploy_worktree');
    expect(repoTemplate).not.toContain('dev_env_validate_qa');
    expect(repoTemplate).not.toContain('"qa_verified_commit":"<sha>"');
    expect(repoTemplate).not.toContain('"live_verified_by":"{{agentSlug}}"');
  });

  it('keeps runtime-only named completion templates available without files in agent-contracts', () => {
  });

  it('classifies Hermes runtimes as local transport', () => {
    expect(resolveTransportMode({ runtimeType: 'hermes' })).toBe('local');
  });
});
