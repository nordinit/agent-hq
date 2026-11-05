import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { applyTaskOutcome } from '../../lib/taskOutcome';
import { applyRuntimeFailedOutcome } from '../runs/runtimeFailureEvent';
import {
  AGENT_HQ_RUNTIME_SOURCE,
  createWorkflowEventMapping,
  resolveWorkflowEventMapping,
  seedDefaultWorkflowEventMappings,
} from './externalEventMappings';

jest.mock('../../lib/taskOutcome', () => ({ applyTaskOutcome: jest.fn() }));

describe('configuration owns workflow-event status filters', () => {
  beforeEach(async () => {
    await setupTestDb();
    jest.clearAllMocks();
    const db = getDb();
    await db.run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Test','test',1)");
    await db.run("INSERT INTO projects (id,tenant_id,name) VALUES (1,1,'Test')");
    await db.run("INSERT INTO workflow_types (tenant_id,key,name) VALUES (1,'generic','Generic')");
    await db.run("INSERT INTO workflows (id,tenant_id,project_id,name,workflow_type) VALUES (1,1,1,'Test','generic')");
    await db.run("INSERT INTO tasks (id,tenant_id,project_id,workflow_id,title,status) VALUES (1,1,1,1,'Test','done')");
    await seedDefaultWorkflowEventMappings(db);
  });

  afterEach(teardownTestDb);

  async function failAt(status: string): Promise<void> {
    const db = getDb();
    await db.run('UPDATE tasks SET status = ? WHERE id = 1', status);
    await applyRuntimeFailedOutcome(db, {
      taskId: 1, instanceId: 1, changedBy: 'test', priorTaskStatus: status,
      summary: 'Runtime failed', runtimeEndSource: 'test', runtimeEndError: 'test error',
    });
  }

  it.each(['done', 'failed', 'cancelled', 'custom_followup'])(
    'posts the built-in runtime_failed outcome from %s without a mapping or a status-name exception',
    async status => {
      await failAt(status);
      expect(applyTaskOutcome).toHaveBeenCalledWith(getDb(), expect.objectContaining({
        taskId: 1, outcome: 'runtime_failed',
      }));
    },
  );

  it('installs no runtime_failed mapping and refuses one, because a dead run always posts the built-in outcome', async () => {
    const db = getDb();
    expect(await db.value(`SELECT count(*) FROM external_event_mappings WHERE event_name = 'runtime_failed' OR action_target = 'runtime_failed'`)).toBe(0);
    await expect(createWorkflowEventMapping(db, {
      tenant_id: 1, source: AGENT_HQ_RUNTIME_SOURCE, event_name: 'runtime_failed', action_kind: 'ignore',
    })).rejects.toThrow('not a configurable event');
    await expect(createWorkflowEventMapping(db, {
      tenant_id: 1, source: 'deploy_bot', event_name: 'deploy_failed', action_kind: 'outcome', action_target: 'runtime_failed',
    })).rejects.toThrow('posted only by Agent HQ');
  });

  it('does not overwrite edited guards or recreate disabled defaults during reinstall', async () => {
    const db = getDb();
    await db.run(`UPDATE external_event_mappings SET status_excludes_json = '[]'
      WHERE source = ? AND event_name = 'agent_started'`, AGENT_HQ_RUNTIME_SOURCE);
    await db.run(`UPDATE external_event_mappings
      SET status_includes_json = '["custom_followup"]', status_excludes_json = '[]', enabled = 0
      WHERE source = ? AND event_name = 'missing_outcome'`, AGENT_HQ_RUNTIME_SOURCE);
    const before = await db.all('SELECT * FROM external_event_mappings ORDER BY id');
    await seedDefaultWorkflowEventMappings(db);
    expect(await db.all('SELECT * FROM external_event_mappings ORDER BY id')).toEqual(before);
    expect(await resolveWorkflowEventMapping(db, {
      source: AGENT_HQ_RUNTIME_SOURCE, eventName: 'missing_outcome', tenantId: 1,
      projectId: 1, taskType: null, currentStatus: 'custom_followup',
    })).toBeNull();
  });
});
