-- Indexes for the bounded task reads: the board's newest-tasks-per-column window
-- (GET /tasks/board) and the id-cursor pages of a task's history, notes and runs.
-- The board partitions a project's tasks by workflow and status and takes the newest of each,
-- so it reads (project_id, workflow_id, status) in (created_at DESC, id DESC) order.
CREATE INDEX IF NOT EXISTS idx_tasks_board_columns
  ON tasks.tasks (project_id, workflow_id, status, created_at DESC, id DESC);
-- Workflow-scoped task lists and the closed-workflow filter join on workflow_id alone.
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks.tasks (workflow_id);
-- Pages go newest first by id within one task.
CREATE INDEX IF NOT EXISTS idx_task_history_task_id_desc ON tasks.task_history (task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_task_notes_task_id_desc ON tasks.task_notes (task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_instances_task_id_desc ON runs.job_instances (task_id, id DESC);
