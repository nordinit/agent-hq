-- Drop the dead workflow-template model.
--
-- sprint_workflow_templates / sprint_workflow_statuses / sprint_workflow_transitions
-- (renamed to workflow_templates / workflow_statuses / workflow_transitions by
-- migration 10) described an abstract workflow lifecycle that was seeded once on
-- 2026-04-09 and never wired to anything:
--
--   * No route ever served them. docs/agent-hq-mcp.md advertised
--     GET /api/v1/sprints/workflow-templates, which was never implemented.
--   * Every code reference was DDL, per-tenant seeding, or rename bookkeeping.
--     Nothing in domains/, services/, routes/ or scheduler/ ever read a row.
--   * Their status vocabulary (planned/building/verifying/shipped/queued/
--     executing/validated) is disjoint from the real task statuses, and no task
--     has ever held one of those statuses.
--
-- The live model is sprint_task_transitions (+ _routing_rules, _requirements),
-- which is untouched by this migration.
--
-- sprints.workflow_template_key is left in place deliberately: it is inert (written
-- by starter templates, round-tripped by project portability, never read), and
-- dropping a column from the hot sprints/workflows table is a separable change.
--
-- Idempotent across both namings so it is safe to apply before or after
-- migrations 10 and 11.

BEGIN;

-- Post-rename names (migration 10 applied). CASCADE is what removes migration 11's
-- read-only compatibility views, which are defined over these tables. A bare
-- DROP VIEW IF EXISTS on the legacy names is NOT a safe substitute: IF EXISTS only
-- guards absence, so it raises "is not a view" when the legacy name is still a table
-- (the pre-migration-10 state). CASCADE is safe to use here for the same reason this
-- migration exists — nothing else in the schema references these tables.
DROP TABLE IF EXISTS "workflow_transitions" CASCADE;
DROP TABLE IF EXISTS "workflow_statuses" CASCADE;
DROP TABLE IF EXISTS "workflow_templates" CASCADE;

-- Pre-rename names (migration 10 not yet applied). Children first, so the
-- template_id foreign keys are gone before their parent.
DROP TABLE IF EXISTS "sprint_workflow_transitions" CASCADE;
DROP TABLE IF EXISTS "sprint_workflow_statuses" CASCADE;
DROP TABLE IF EXISTS "sprint_workflow_templates" CASCADE;

COMMIT;
