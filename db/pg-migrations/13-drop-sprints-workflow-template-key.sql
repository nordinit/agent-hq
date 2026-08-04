-- Drop sprints.workflow_template_key.
--
-- The column was the last reference to the workflow-template model removed by
-- migration 12. It was written by the starter-template installer and round-tripped
-- by project portability, but never read to make a decision — an inert label whose
-- referent no longer exists.
--
-- Project manifests exported before this still carry the field. That is safe:
-- projectPortability inserts through insertDynamic, which filters to columns that
-- actually exist, so the value is ignored rather than erroring.
--
-- Idempotent across both namings, so it is safe to apply before or after the
-- pending table rename in migration 10.

BEGIN;

ALTER TABLE IF EXISTS "sprints"   DROP COLUMN IF EXISTS "workflow_template_key";
ALTER TABLE IF EXISTS "workflows" DROP COLUMN IF EXISTS "workflow_template_key";

COMMIT;
