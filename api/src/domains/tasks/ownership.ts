import { type Db } from "../../db/adapter/types";
import { columnExists as sharedColumnExists } from "../../db/introspection";

export async function taskTableHasColumn(db: Db, column: string): Promise<boolean> {
  return await sharedColumnExists(db, 'tasks', column);
}

export async function syncTaskActiveAgentFromInstance(db: Db, taskId: number): Promise<void> {
  if (!await taskTableHasColumn(db, 'assigned_agent_id') || !await taskTableHasColumn(db, 'agent_id') || !await taskTableHasColumn(db, 'active_instance_id')) return;

  await db.run(`
    UPDATE tasks
    SET agent_id = (
          SELECT ji.agent_id
          FROM job_instances ji
          WHERE ji.id = tasks.active_instance_id
        ),
        updated_at = datetime('now')
    WHERE id = ?
  `, taskId);
}

export async function syncAllTaskActiveAgentsFromInstances(db: Db): Promise<void> {
  if (!await taskTableHasColumn(db, 'assigned_agent_id') || !await taskTableHasColumn(db, 'agent_id') || !await taskTableHasColumn(db, 'active_instance_id')) return;

  await db.run(`
    UPDATE tasks
    SET agent_id = (
          SELECT ji.agent_id
          FROM job_instances ji
          WHERE ji.id = tasks.active_instance_id
        )
  `);
}
