-- Move the global gate requirements down to the dev workflow, then drop the global table.
--
-- `transition_requirements` had no project_id, sprint_type, sprint_id or tenant_id. Every
-- workflow of every project in every tenant read the same rows, and they were consulted as a
-- fallback: `loadTransitionRequirements` used them only when the scoped lookup returned
-- nothing for a (workflow, outcome, task_type). That made the fallback REPLACE rather than
-- accumulate, with two consequences that cost real time:
--
--   * Disabling gates one at a time was safe right up until the last one, at which point the
--     outcome silently handed off to a set of rows the operator had never seen — all of them
--     severity 'block'. This deadlocked live tasks.
--   * The rows encode the dev commit-evidence contract (review_branch, review_commit,
--     qa_verified_commit and the status guards). A lead-generation or preconstruction
--     workflow that happened to use outcome `approval_blocked` was gated on `review_branch`,
--     a field its task schema does not even define.
--
-- The content is not lost: `devWorkflowRequirements()` in domains/routing/policy/metadata.ts
-- already carried 14 of the 15 distinct rows as the dev starter policy, so this is mostly a
-- matter of writing down where they already belonged. The 15th, `approval_blocked ->
-- review_branch`, joins that starter policy in the same change. (Production held 16 rows; two
-- were an exact duplicate pair.)
--
-- WHAT THIS INSERTS
--
-- For every project owning at least one dev workflow, the global rows are written as
-- workflow-type defaults (sprint_id IS NULL, sprint_type = 'dev'), but only where doing so
-- cannot change what any existing workflow already enforces. Two guards:
--
--   1. Skip an outcome the workflow already answers at workflow level. Those rows are a
--      deliberate override — their existence is exactly why the global fallback never reached
--      that outcome — so re-adding the global set on top would tighten them.
--   2. Skip an outcome where any single workflow resolves a NON-EMPTY set today that does not
--      already contain the global rows. Workflow-level and workflow-scoped rows MERGE (they
--      are deduped on identity, not replaced), so an insert would add gates to that workflow.
--      A workflow resolving nothing today is the case this migration exists to serve: it was
--      falling through to the global table, and it now gets the same rows locally.
--
-- Both guards are evaluated against `task_type IS NULL` rows, which is what the global table
-- holds. The block below refuses to run if that stops being true, rather than silently
-- leaving a task-typed outcome ungated.
--
-- Everything is inside one DO block with the insert issued through EXECUTE, so the statement
-- naming the dropped table is never parsed once it is gone. That makes the migration
-- re-runnable: on a database that already has it, the guard short-circuits and it is a no-op.

BEGIN;

DO $migration$
DECLARE
  typed_rows bigint;
BEGIN
  IF to_regclass('public.transition_requirements') IS NULL THEN
    RAISE NOTICE 'transition_requirements is already gone; nothing to move.';
    RETURN;
  END IF;

  SELECT count(*) INTO typed_rows
  FROM transition_requirements
  WHERE enabled = 1 AND task_type IS NOT NULL;

  IF typed_rows > 0 THEN
    RAISE EXCEPTION
      'Migration 15 handles task_type IS NULL global requirements only, but % enabled task-typed row(s) exist. '
      'Move them to their workflows by hand, then re-run.', typed_rows;
  END IF;

  EXECUTE $insert$
    INSERT INTO sprint_task_transition_requirements (
      sprint_id, project_id, sprint_type, tenant_id, task_type, outcome, field_name,
      requirement_type, match_field, severity, message, enabled, priority
    )
    SELECT
      NULL, w.project_id, 'dev', w.tenant_id, NULL, g.outcome, g.field_name,
      g.requirement_type, g.match_field, g.severity, g.message, 1, g.priority
    FROM (
      -- One row per project owning a dev workflow, with the tenant those workflows sit in.
      SELECT project_id, min(tenant_id) AS tenant_id
      FROM sprints
      WHERE sprint_type = 'dev'
      GROUP BY project_id
    ) w
    CROSS JOIN (
      -- The global set, deduped: production carried an exact duplicate pair on
      -- approval_blocked, and inserting both would put two identical rows on every workflow.
      SELECT DISTINCT ON (outcome, field_name, requirement_type, COALESCE(match_field, ''))
             outcome, field_name, requirement_type, match_field, severity, message, priority
      FROM transition_requirements
      WHERE enabled = 1 AND task_type IS NULL
      ORDER BY outcome, field_name, requirement_type, COALESCE(match_field, ''), priority DESC, id
    ) g
    -- Guard 1: the workflow already answers this outcome at workflow level.
    WHERE NOT EXISTS (
      SELECT 1 FROM sprint_task_transition_requirements existing
      WHERE existing.project_id = w.project_id
        AND existing.sprint_type = 'dev'
        AND existing.sprint_id IS NULL
        AND existing.task_type IS NULL
        AND existing.enabled = 1
        AND existing.outcome = g.outcome
    )
    -- Guard 2: some workflow resolves a non-empty set for this outcome that is missing at
    -- least one global row, so inserting would add a gate it does not enforce today.
    AND NOT EXISTS (
      SELECT 1
      FROM sprints s
      WHERE s.project_id = w.project_id
        AND s.sprint_type = 'dev'
        AND EXISTS (
          SELECT 1 FROM sprint_task_transition_requirements cur
          WHERE cur.project_id = s.project_id AND cur.sprint_type = 'dev'
            AND (cur.sprint_id = s.id OR cur.sprint_id IS NULL)
            AND cur.task_type IS NULL AND cur.enabled = 1
            AND cur.outcome = g.outcome
        )
        AND EXISTS (
          SELECT 1
          FROM transition_requirements missing
          WHERE missing.enabled = 1 AND missing.task_type IS NULL
            AND missing.outcome = g.outcome
            AND NOT EXISTS (
              SELECT 1 FROM sprint_task_transition_requirements have
              WHERE have.project_id = s.project_id AND have.sprint_type = 'dev'
                AND (have.sprint_id = s.id OR have.sprint_id IS NULL)
                AND have.task_type IS NULL AND have.enabled = 1
                AND have.outcome = missing.outcome
                AND have.field_name = missing.field_name
                AND have.requirement_type = missing.requirement_type
                AND COALESCE(have.match_field, '') = COALESCE(missing.match_field, '')
            )
        )
    )
  $insert$;

  EXECUTE 'DROP INDEX IF EXISTS idx_transition_req_lookup';
  EXECUTE 'DROP INDEX IF EXISTS idx_transition_req_type';
  EXECUTE 'DROP TABLE transition_requirements';
END
$migration$;

COMMIT;
