# Workflow terminology migration

Migration 32 and this application release must deploy together. The API, UI, MCP tools, permission capabilities, task fields, routing configuration, exports, schedulers and physical database schema use `workflow` throughout. The former request/response alias middleware has been removed. In particular, telemetry scope reaches validation unchanged as `workflow_type` and `workflow_id`.

Existing clients must use `/api/v1/workflows`, `workflow_id`, `workflow_type`, `workflow_type_key`, and `source_workflow_id`. MCP clients should refresh their tool catalog after deployment. Export packages now use workflow-named collections and references.

The migration renames existing tables and columns in place; it preserves primary keys, relationships, telemetry signal generation UUIDs, capture start times and coverage cursors. It updates database trigger function bodies and persisted MCP capability grants, runtime policies, and installed agent/skill instructions. Historical event source keys, payloads, revision hashes and retained proofs preserve their original provenance. User-authored titles, custom fields, patterns and historical conversations are not rewritten.

Applied SQL migrations and tests that exercise their historical schemas necessarily contain the former names. Their checksums remain unchanged. `node scripts/check-workflow-terminology.mjs` prevents those names from returning to active application code, shipped skills or scripts.

Deployment requires a verified database backup, stopping production API writers, applying the migration, and starting the matching API/UI release. Reverting only the application is unsafe after the schema migration; recovery requires restoring the database backup with the previous release. Rehearse this migration against a restored database before the production cutover.
