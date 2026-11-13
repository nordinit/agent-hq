-- An archived project keeps its data but leaves normal navigation and automation: the dispatcher,
-- the recurring-task scheduler and assignment display skip it, list endpoints hide it and its
-- contents unless asked, and only an archived project can be deleted. NULL means active.
ALTER TABLE core.projects ADD COLUMN archived_at TIMESTAMPTZ;
COMMENT ON COLUMN core.projects.archived_at IS 'When the project was archived; NULL while it is active.';
