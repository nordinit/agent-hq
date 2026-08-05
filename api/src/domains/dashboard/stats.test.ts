import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { getDashboardTokenUsageLast24h } from './stats';
import { type Db } from "../../db/adapter/types";

describe('getDashboardTokenUsageLast24h', () => {
  let db: Db;
  let agentId: number;

  const seedProject = async (name: string): Promise<number> =>
    Number((await db.run(`INSERT INTO projects (name) VALUES (?)`, name)).lastInsertId);

  const seedAgent = async (sessionKey: string, projectId: number | null = null): Promise<number> =>
    Number((await db.run(
      `INSERT INTO agents (name, session_key, project_id) VALUES (?, ?, ?)`,
      sessionKey, sessionKey, projectId,
    )).lastInsertId);

  // tasks.sprint_id is NOT NULL and references sprints, so a task cannot be seeded on its own —
  // it needs a workflow, which in turn needs the project. The scope test only cares about
  // tasks.project_id; the workflow exists solely to satisfy the constraint.
  const seedTask = async (title: string, projectId: number): Promise<number> => {
    const sprint = await db.run(`INSERT INTO sprints (project_id, name) VALUES (?, ?)`, projectId, `${title} workflow`);
    return Number((await db.run(
      `INSERT INTO tasks (title, project_id, sprint_id) VALUES (?, ?, ?)`,
      title, projectId, Number(sprint.lastInsertId),
    )).lastInsertId);
  };

  beforeEach(async () => {
    await setupTestDb();
    db = getDb();
    // job_instances.agent_id is NOT NULL with an FK to agents, so even the cases that never look
    // at the agent need one real row to hang their runs off.
    agentId = await seedAgent('stats-agent');
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('includes token usage from the rolling last 24 hours and excludes older usage', async () => {
    await db.run(`
      INSERT INTO job_instances (agent_id, created_at, token_input, token_output, token_total)
      VALUES
        (?, to_char(now() AT TIME ZONE 'utc' - interval '23 hours', 'YYYY-MM-DD HH24:MI:SS'), 10, 15, NULL),
        (?, to_char(now() AT TIME ZONE 'utc' - interval '24 hours 1 minute', 'YYYY-MM-DD HH24:MI:SS'), 100, 200, NULL),
        (?, to_char(now() AT TIME ZONE 'utc' - interval '2 hours', 'YYYY-MM-DD HH24:MI:SS'), 1, 2, 50)
    `, agentId, agentId, agentId);

    expect(await getDashboardTokenUsageLast24h(db)).toBe(75);
  });

  it('uses the latest run lifecycle timestamp so delayed token writes are counted', async () => {
    await db.run(`
      INSERT INTO job_instances (
        agent_id, created_at, completed_at, runtime_ended_at, token_input, token_output, token_total
      )
      VALUES
        (?, to_char(now() AT TIME ZONE 'utc' - interval '25 hours', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS'), 20, 30, NULL),
        (?, to_char(now() AT TIME ZONE 'utc' - interval '25 hours', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc' - interval '25 hours', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc' - interval '25 hours', 'YYYY-MM-DD HH24:MI:SS'), 100, 200, NULL),
        (?, to_char(now() AT TIME ZONE 'utc' - interval '26 hours', 'YYYY-MM-DD HH24:MI:SS'), NULL, to_char(now() AT TIME ZONE 'utc' - interval '2 hours', 'YYYY-MM-DD HH24:MI:SS'), NULL, NULL, 75)
    `, agentId, agentId, agentId);

    expect(await getDashboardTokenUsageLast24h(db)).toBe(125);
  });

  it('applies project scope to task-owned and unassigned agent-owned runs', async () => {
    const inScope = await seedProject('In scope');
    const outOfScope = await seedProject('Out of scope');
    const agentInScope = await seedAgent('agent-in-scope', inScope);
    const agentOutOfScope = await seedAgent('agent-out-of-scope', outOfScope);
    const taskInScope = await seedTask('Task in scope', inScope);
    const taskOutOfScope = await seedTask('Task out of scope', outOfScope);

    await db.run(`
      INSERT INTO job_instances (task_id, agent_id, created_at, token_input, token_output, token_total)
      VALUES
        (?, ?, to_char(now() AT TIME ZONE 'utc' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS'), 5, 5, NULL),
        (?, ?, to_char(now() AT TIME ZONE 'utc' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS'), 100, 100, NULL),
        (NULL, ?, to_char(now() AT TIME ZONE 'utc' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS'), 7, 8, NULL),
        (NULL, ?, to_char(now() AT TIME ZONE 'utc' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS'), 200, 200, NULL)
    `,
      // The task owns the scope when there is one, so an out-of-scope agent on an in-scope task
      // still counts — and an in-scope agent on an out-of-scope task does not.
      taskInScope, agentOutOfScope,
      taskOutOfScope, agentInScope,
      agentInScope,
      agentOutOfScope,
    );

    expect(await getDashboardTokenUsageLast24h(db, inScope)).toBe(25);
  });
});
