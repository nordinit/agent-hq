import type Database from 'better-sqlite3';

export function taskTableHasColumn(db: Database.Database, column: string): boolean {
  return (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).some((col) => col.name === column);
}

export function syncTaskActiveAgentFromInstance(db: Database.Database, taskId: number): void {
  if (!taskTableHasColumn(db, 'assigned_agent_id') || !taskTableHasColumn(db, 'agent_id') || !taskTableHasColumn(db, 'active_instance_id')) return;

  db.prepare(`
    UPDATE tasks
    SET agent_id = (
          SELECT ji.agent_id
          FROM job_instances ji
          WHERE ji.id = tasks.active_instance_id
        ),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);
}

export function syncAllTaskActiveAgentsFromInstances(db: Database.Database): void {
  if (!taskTableHasColumn(db, 'assigned_agent_id') || !taskTableHasColumn(db, 'agent_id') || !taskTableHasColumn(db, 'active_instance_id')) return;

  db.prepare(`
    UPDATE tasks
    SET agent_id = (
          SELECT ji.agent_id
          FROM job_instances ji
          WHERE ji.id = tasks.active_instance_id
        )
  `).run();
}
