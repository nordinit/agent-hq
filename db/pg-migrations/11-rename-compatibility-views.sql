-- One-release compatibility views, mapping the OLD names onto the renamed tables.
-- Generated; see 10-rename-legacy-terminology.sql.
--
-- These exist so an application rollback does not require a schema rollback. They are
-- READ-ONLY: a simple view over a renamed table is auto-updatable in PostgreSQL, which
-- would let stale code keep writing through the old vocabulary indefinitely and quietly
-- defeat the migration. WITH (security_barrier) plus an explicit rule blocks writes.
-- Remove this file one release after the rename ships.

BEGIN;
CREATE VIEW "sprint_task_routing_rules" WITH (security_barrier) AS SELECT * FROM "workflow_task_routing_rules";
CREATE RULE "sprint_task_routing_rules_no_insert" AS ON INSERT TO "sprint_task_routing_rules" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_routing_rules_no_update" AS ON UPDATE TO "sprint_task_routing_rules" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_routing_rules_no_delete" AS ON DELETE TO "sprint_task_routing_rules" DO INSTEAD NOTHING;
CREATE VIEW "sprint_task_statuses" WITH (security_barrier) AS SELECT * FROM "workflow_task_statuses";
CREATE RULE "sprint_task_statuses_no_insert" AS ON INSERT TO "sprint_task_statuses" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_statuses_no_update" AS ON UPDATE TO "sprint_task_statuses" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_statuses_no_delete" AS ON DELETE TO "sprint_task_statuses" DO INSTEAD NOTHING;
CREATE VIEW "sprint_task_transition_requirement_tombstones" WITH (security_barrier) AS SELECT * FROM "workflow_task_transition_requirement_tombstones";
CREATE RULE "sprint_task_transition_requirement_tombstones_no_insert" AS ON INSERT TO "sprint_task_transition_requirement_tombstones" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_transition_requirement_tombstones_no_update" AS ON UPDATE TO "sprint_task_transition_requirement_tombstones" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_transition_requirement_tombstones_no_delete" AS ON DELETE TO "sprint_task_transition_requirement_tombstones" DO INSTEAD NOTHING;
CREATE VIEW "sprint_task_transition_requirements" WITH (security_barrier) AS SELECT * FROM "workflow_task_transition_requirements";
CREATE RULE "sprint_task_transition_requirements_no_insert" AS ON INSERT TO "sprint_task_transition_requirements" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_transition_requirements_no_update" AS ON UPDATE TO "sprint_task_transition_requirements" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_transition_requirements_no_delete" AS ON DELETE TO "sprint_task_transition_requirements" DO INSTEAD NOTHING;
CREATE VIEW "sprint_task_transitions" WITH (security_barrier) AS SELECT * FROM "workflow_task_transitions";
CREATE RULE "sprint_task_transitions_no_insert" AS ON INSERT TO "sprint_task_transitions" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_transitions_no_update" AS ON UPDATE TO "sprint_task_transitions" DO INSTEAD NOTHING;
CREATE RULE "sprint_task_transitions_no_delete" AS ON DELETE TO "sprint_task_transitions" DO INSTEAD NOTHING;
CREATE VIEW "sprint_type_outcomes" WITH (security_barrier) AS SELECT * FROM "workflow_type_outcomes";
CREATE RULE "sprint_type_outcomes_no_insert" AS ON INSERT TO "sprint_type_outcomes" DO INSTEAD NOTHING;
CREATE RULE "sprint_type_outcomes_no_update" AS ON UPDATE TO "sprint_type_outcomes" DO INSTEAD NOTHING;
CREATE RULE "sprint_type_outcomes_no_delete" AS ON DELETE TO "sprint_type_outcomes" DO INSTEAD NOTHING;
CREATE VIEW "sprint_type_relationship_types" WITH (security_barrier) AS SELECT * FROM "workflow_type_relationship_types";
CREATE RULE "sprint_type_relationship_types_no_insert" AS ON INSERT TO "sprint_type_relationship_types" DO INSTEAD NOTHING;
CREATE RULE "sprint_type_relationship_types_no_update" AS ON UPDATE TO "sprint_type_relationship_types" DO INSTEAD NOTHING;
CREATE RULE "sprint_type_relationship_types_no_delete" AS ON DELETE TO "sprint_type_relationship_types" DO INSTEAD NOTHING;
CREATE VIEW "sprint_type_task_statuses" WITH (security_barrier) AS SELECT * FROM "workflow_type_task_statuses";
CREATE RULE "sprint_type_task_statuses_no_insert" AS ON INSERT TO "sprint_type_task_statuses" DO INSTEAD NOTHING;
CREATE RULE "sprint_type_task_statuses_no_update" AS ON UPDATE TO "sprint_type_task_statuses" DO INSTEAD NOTHING;
CREATE RULE "sprint_type_task_statuses_no_delete" AS ON DELETE TO "sprint_type_task_statuses" DO INSTEAD NOTHING;
CREATE VIEW "sprint_type_task_types" WITH (security_barrier) AS SELECT * FROM "workflow_type_task_types";
CREATE RULE "sprint_type_task_types_no_insert" AS ON INSERT TO "sprint_type_task_types" DO INSTEAD NOTHING;
CREATE RULE "sprint_type_task_types_no_update" AS ON UPDATE TO "sprint_type_task_types" DO INSTEAD NOTHING;
CREATE RULE "sprint_type_task_types_no_delete" AS ON DELETE TO "sprint_type_task_types" DO INSTEAD NOTHING;
CREATE VIEW "sprint_types" WITH (security_barrier) AS SELECT * FROM "workflow_types";
CREATE RULE "sprint_types_no_insert" AS ON INSERT TO "sprint_types" DO INSTEAD NOTHING;
CREATE RULE "sprint_types_no_update" AS ON UPDATE TO "sprint_types" DO INSTEAD NOTHING;
CREATE RULE "sprint_types_no_delete" AS ON DELETE TO "sprint_types" DO INSTEAD NOTHING;
CREATE VIEW "sprint_workflow_statuses" WITH (security_barrier) AS SELECT * FROM "workflow_statuses";
CREATE RULE "sprint_workflow_statuses_no_insert" AS ON INSERT TO "sprint_workflow_statuses" DO INSTEAD NOTHING;
CREATE RULE "sprint_workflow_statuses_no_update" AS ON UPDATE TO "sprint_workflow_statuses" DO INSTEAD NOTHING;
CREATE RULE "sprint_workflow_statuses_no_delete" AS ON DELETE TO "sprint_workflow_statuses" DO INSTEAD NOTHING;
CREATE VIEW "sprint_workflow_templates" WITH (security_barrier) AS SELECT * FROM "workflow_templates";
CREATE RULE "sprint_workflow_templates_no_insert" AS ON INSERT TO "sprint_workflow_templates" DO INSTEAD NOTHING;
CREATE RULE "sprint_workflow_templates_no_update" AS ON UPDATE TO "sprint_workflow_templates" DO INSTEAD NOTHING;
CREATE RULE "sprint_workflow_templates_no_delete" AS ON DELETE TO "sprint_workflow_templates" DO INSTEAD NOTHING;
CREATE VIEW "sprint_workflow_transitions" WITH (security_barrier) AS SELECT * FROM "workflow_transitions";
CREATE RULE "sprint_workflow_transitions_no_insert" AS ON INSERT TO "sprint_workflow_transitions" DO INSTEAD NOTHING;
CREATE RULE "sprint_workflow_transitions_no_update" AS ON UPDATE TO "sprint_workflow_transitions" DO INSTEAD NOTHING;
CREATE RULE "sprint_workflow_transitions_no_delete" AS ON DELETE TO "sprint_workflow_transitions" DO INSTEAD NOTHING;
CREATE VIEW "sprints" WITH (security_barrier) AS SELECT * FROM "workflows";
CREATE RULE "sprints_no_insert" AS ON INSERT TO "sprints" DO INSTEAD NOTHING;
CREATE RULE "sprints_no_update" AS ON UPDATE TO "sprints" DO INSTEAD NOTHING;
CREATE RULE "sprints_no_delete" AS ON DELETE TO "sprints" DO INSTEAD NOTHING;
COMMIT;
