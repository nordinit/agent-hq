<!--
RECOVERED DOCUMENT — PROVENANCE

Source: git blob 363296b8d3cab50da8885abae7bb1857007c566b
Commit: 8b234a8a71914e43d2bb869a6e2c2b215e9449cb ("Remove legacy lane routing metadata", Cinder,
        2026-06-03) — the FINAL revision of this file before deletion.
Created at: 3dc9283a20ebf0b4f9b2189ce50c665aa8e70d52 ("docs: audit legacy data model surface",
        Cinder, 2026-06-02), blob af5d20aa832eab27a2a6a713f46d22cef2a2cc65.
Deleted by: 494509b5a131347e41964768ae0491f76570c8f2 ("Prepare repository for public release under
        nord-initiatives", 2026-06-11).

NOTE ON WHICH REVISION WAS RECOVERED: the recovery audit named 3dc9283 (the creation commit), but
this file had a second revision. 8b234a8 amended finding F13 after task #743 landed the lane-metadata
cleanup, and amended one line under "Terminology Drift". The LATER revision is reproduced here
because it is the final state of the document and the F13 text at 3dc9283 is now factually stale.
The superseded 3dc9283 wording is preserved verbatim at the end of this file under
"APPENDIX: Superseded F13 text from 3dc9283" so nothing from the cited revision is lost.

Both commits PREDATE the 2026-06-11 public re-root. `main` was re-rooted at b2c3705 ("Initial public
release"), so neither commit is an ancestor of HEAD and this file is absent from the working tree,
from HEAD, and from a fresh clone. It survived only as an unreachable object in this worktree's
object store and would be destroyed by a routine `git gc`.

CONTENTS DESCRIBE THE PRE-MIGRATION STATE. The F1-F15 findings, line-number citations and file paths
reflect the repository as of 2026-06-03 and have not been re-verified against current code. Several
findings have since been actioned (F13 by task #743; the lifecycle-evidence surface in F6 was
reworked by the 995-series commits). Read it as historical input, not as current fact.
-->

# Agent HQ Legacy Data Model Audit

Date: 2026-06-03
Task: #714
Owner area: Backend/API/database/runtime, with UI/docs follow-up

## Executive Summary

Agent HQ's launch data model still carries several transition-era surfaces. The highest-value cleanup candidates are:

1. **Retire removed feature API shims**: `/api/v1/sprints/:id/jobs` and `/api/v1/sprints/:id/schedules` still expose deprecated sprint-scoped job/schedule concepts even though the underlying tables were removed.
2. **Consolidate task relationship storage**: `task_relationships` is the current relationship model, but `task_dependencies`, `tasks.origin_task_id`, and `tasks.defect_type` still act as legacy mirrors/read paths.
3. **Choose the canonical evidence storage**: launch currently stores review/QA/deploy/live evidence both as inline `tasks` columns and in `custom_fields_json`; this is useful for gates but should be made explicit before the schema hardens.
4. **Finish jobs-to-agents cleanup**: `job_instances`, `agents.job_*`, `agents.sprint_id`, `agents.schedule`, `job_id` request/query aliases, and docs still preserve job-era naming.
5. **Plan a workflow/sprint naming cutover**: the UI/docs increasingly say "workflow", but the persisted model and many APIs are still `sprint_*`. This is a large rename and should not be done opportunistically before launch unless Masiah wants a hard compatibility break.

No schema, migration, or code cleanup was performed in this task.

## Scope Covered

- Database schema and inline migrations in `api/src/db/schema.ts`
- Backend task, routing, sprint/workflow, run, and dispatcher model paths
- Seed/config data in `api/src/lib/starterCatalog.ts`, `api/src/lib/starterSetup.ts`, and routing policy setup
- API compatibility serializers and sprint endpoints
- Frontend/documentation terminology assumptions found by repository search
- Agent contract/runtime language that still exposes legacy fields

## Findings

| ID | Surface | Classification | Risk | Evidence | Current readers/writers | Recommended action |
|---|---|---:|---:|---|---|---|
| F1 | Removed sprint job/schedule endpoints | Safe removal candidate | Medium | `api/src/routes/sprints.ts:134`, `api/src/routes/sprints.ts:157`; schema comments at `api/src/db/schema.ts:1163`, `api/src/db/schema.ts:1225`, `api/src/db/schema.ts:4983` | API clients can still call sprint job attach/detach; schedule endpoints return empty/410 compatibility responses | Create follow-up to remove these endpoints from API and docs after confirming no UI caller remains. Keep recurring task series as the replacement. |
| F2 | `routing_config_legacy` rename/drop no-op path | Safe removal candidate | Low | `api/src/db/schema.ts:256`, `api/src/db/schema.ts:1651`, `api/src/db/schema.ts:4983`; dispatcher comment at `api/src/services/dispatcher.ts:443` | Schema init can still rename an old `routing_config` into `routing_config_legacy`, then later drops it | Remove the no-op function and old rename path once production DBs are confirmed past task #596. |
| F3 | Deprecated runtime lifecycle config keys | Safe removal candidate after data check | Low | `api/src/db/schema.ts:75` removes `runtime_config.lifecycleProxy` and `runtime_config.lifecycleMode`; historical doc at `docs/hermes-runtime-phase-0-inventory.md:3` | Schema init mutates existing `agents.runtime_config`; Hermes/webhook runtime code uses current runtime config fields | Run a production/dev data check for those keys. If zero, remove the scrubber and docs references. |
| F4 | Task dependency mirror alongside relationship model | Risky removal requiring migration/backfill | High | `api/src/db/schema.ts:143`, `api/src/db/schema.ts:201`, `api/src/db/schema.ts:1231`; `api/src/domains/tasks/relationships.ts:212`; `api/src/domains/tasks/readModel.ts:57`; dispatcher blocker eligibility in `api/src/services/dispatcher.ts:897` | Dispatch eligibility still reads `task_dependencies`; relationship writes mirror dependency rows for blocking semantics | Keep for launch unless a dedicated migration moves dispatch eligibility fully to `task_relationships`. Follow-up should backfill, switch dispatcher/read model, then drop mirror writes. |
| F5 | `tasks.origin_task_id` and `tasks.defect_type` legacy defect fields | Risky removal requiring migration/backfill | Medium | Backfill into relationships at `api/src/db/schema.ts:212`; added columns at `api/src/db/schema.ts:2832`; write model metadata `legacy_defect_type` at `api/src/domains/tasks/writeModel.ts:114`; read filters at `api/src/domains/tasks/readModel.ts:345` | Task create/update still accepts and writes both fields; read model joins origin task and filters by these fields; metrics count spawned defects from `origin_task_id` | Treat `task_relationships(defect_of)` as canonical in a follow-up. Migrate spawned-defect metrics and filters before dropping columns. |
| F6 | Inline lifecycle evidence columns plus `custom_fields_json` mirror | Compatibility shim still needed temporarily | Medium | Evidence fields in starter schema at `api/src/lib/starterCatalog.ts:24`; inline columns at `api/src/db/schema.ts:1255`; backfill into custom fields at `api/src/db/schema.ts:230`; read merge at `api/src/domains/tasks/readModel.ts:51`; status gates in `api/src/domains/tasks/writeModel.ts:381` | Lifecycle/task MCP evidence and release gates depend on inline fields; UI field schema exposes the same names as custom fields | Do not remove before launch. Decide whether launch contract is inline evidence columns, structured `evidence_json`, or typed custom fields; then create a consolidation migration. |
| F7 | `tasks.agent_id` versus `tasks.assigned_agent_id` | Compatibility shim still needed temporarily | High | Task table includes both at `api/src/db/schema.ts:706`; backfill at `api/src/db/schema.ts:727`; ownership backfill comments at `api/src/db/schema.ts:4664`; read list fallback at `api/src/domains/tasks/readModel.ts:329`; write model assigns `assigned_agent_id` from `agent_id`/`job_id` at `api/src/domains/tasks/writeModel.ts:337` | Dispatcher uses `agent_id` as active owner/runtime authority and `assigned_agent_id` as assignment; frontend/read models expose both active and assigned names | Keep both until ownership semantics are formally named. Follow-up should document and possibly rename active owner versus assigned owner, not just drop a column. |
| F8 | Jobs-to-agents compatibility columns on `agents` and job aliases | Risky removal requiring product/API decision | High | `job_templates` removed at `api/src/db/schema.ts:444`; compatibility columns at `api/src/db/schema.ts:2304`; `job_instructions` migration at `api/src/db/schema.ts:2331`; task input accepts `job_id` at `api/src/domains/tasks/writeModel.ts:37`; API/list filters use `job_id` at `api/src/domains/tasks/readModel.ts:297` | Dispatcher, routing admin, GitHub identity, UI settings, and task APIs still use job-era names (`job_title`, `job_instructions`, `job_id`) | Do not remove before launch without API versioning. Sequence as: introduce agent-named API aliases, update UI/docs/contracts, then migrate/drop job aliases. |
| F9 | Sprint/workflow naming compatibility | Risky removal requiring product decision | High | Workflow alias middleware maps workflow fields to sprint fields at `api/src/lib/workflowCompatibility.ts:11`; OpenAPI states sprint fields are legacy aliases at `docs/openapi.md:12`; contract exposes `sprint_type` as machine-readable legacy field at `agent-contracts/generic.md:19`; persisted tables remain `sprints`, `sprint_types`, `sprint_task_*` in `api/src/db/schema.ts:788`, `api/src/db/schema.ts:866`, `api/src/db/schema.ts:1678` | UI/docs increasingly use workflow wording; backend/routes still expose `/sprints` and `sprint_*`; task contracts still send `sprint_type` | Keep through launch unless a breaking v2 API/schema rename is approved. Follow-up should define canonical public terms and either accept DB-level legacy naming or plan a multi-release rename. |
| F10 | Deprecated sprint type rows `bugs`, `enhancements`, `pm` | Compatibility cleanup mostly complete | Low | Cleanup maps old types to `dev` and deletes rows at `api/src/db/schema.ts:1127`; starter catalog only seeds `generic`, `dev`, `ops` at `api/src/lib/starterCatalog.ts:6` | Schema init still performs defensive cleanup | Run data check. If zero in production backups, remove the cleanup block after launch; no product behavior should depend on those keys. |
| F11 | Legacy project-level `task_routing_rules` and scoped routing transition | Compatibility cleanup mostly complete | Medium | Comments/drop path at `api/src/db/schema.ts:4664`; current routing table is `sprint_task_routing_rules` at `api/src/db/schema.ts:1756`; dispatcher resolves scoped routing in `api/src/services/dispatcher.ts:962` | Dispatcher/routing admin depend on scoped sprint/project/sprint_type routing | Keep scoped routing model. Remove only residual drop/backfill code after proving all DBs have migrated. |
| F12 | Agent schedules retained after recurring task series | Safe removal candidate after API/UI check | Medium | `agents.schedule` compatibility column at `api/src/db/schema.ts:2312`; task #616 clears legacy schedules at `api/src/db/schema.ts:4996`; recurring series table at `api/src/db/schema.ts:1172` | Recurring task series is the current scheduling model; old agent schedule column remains as compatibility storage | Verify no settings UI/API still writes `agents.schedule`; then drop or hide it from serializers. |
| F13 | Transition/routing lane metadata | Cleanup implemented in task #743 | Low | `routing_config`, `sprint_task_transitions`, and `lifecycle_rules` now drop legacy `lane` columns during schema init; task contracts no longer expose `{{lane}}`; GitHub identities still store a separate credential role field named `lane` | Runtime contracts and transition APIs use status/outcome/task type/workflow type plus configured gate rows, not persisted lane metadata | Keep the GitHub identity credential-role naming scoped to GitHub settings, or rename it separately in a future credentials-focused change. |
| F14 | Atlas system-agent and path compatibility | Risky removal requiring product decision | Medium | Atlas constants imported at `api/src/db/schema.ts:11`; task release gate names Atlas authority in `api/src/domains/tasks/writeModel.ts:381`; workspace fallback uses Atlas root in `api/src/lib/workspaceProvider.ts:581`; UI placeholder still says "Atlas Agents" at `ui/app/settings/github/page.tsx:373` | Atlas remains the system/manual authority label in gates and starter routing fallback | Decide whether "Atlas" is now a product/system actor name or a legacy brand. If legacy, rename authority labels, workspace helpers, seed records, and UI copy together. |
| F15 | Tool registry legacy implementation/assignment shims | Safe removal candidate after data check | Low | Tool table compatibility checks at `api/src/db/schema.ts:3048`; assignment migration checks `tools_legacy_capability_exec` at `api/src/db/schema.ts:3125` | Schema init rebuilds older tool/assignment rows | Run DB check for old values/DDL. If absent, remove rebuild compatibility blocks post-launch. |

## Required For Current Launch Behavior

- `projects`, `agents`, `tasks`, `job_instances`, `logs`, `task_history`, `task_notes`, `instance_artifacts`, `task_events`, and `integrity_events` are current operational tables despite some legacy names.
- `sprints`/`sprint_types`/`sprint_task_*` are current workflow storage, even if public terminology is drifting toward "workflow".
- `sessions`, `session_messages`, `chat_messages`, `canonical_chat_sessions`, and transcript ingest tables are current runtime/chat observability storage.
- `sprint_task_routing_rules`, `sprint_task_transition_requirements`, `external_event_mappings`, and lifecycle/outcome tables are current routing and task truth infrastructure.
- `recurring_task_series` and `recurring_task_runs` are the current replacement for removed sprint job schedules.
- `task_relationships` and `sprint_type_relationship_types` are current relationship storage, but dispatch still needs the dependency mirror until F4 is resolved.

## Terminology Drift

- Public docs already state workflow endpoints are preferred while sprint fields remain compatibility aliases (`docs/openapi.md:12`).
- Agent contracts still expose `sprint_type` as a machine-readable compatibility field; `lane` is no longer a contract placeholder.
- API routes remain `/api/v1/sprints` and emit both workflow and sprint fields through compatibility middleware.
- UI search shows legacy display strings remain in places such as GitHub settings placeholder "Atlas Agents" (`ui/app/settings/github/page.tsx:373`).

Recommendation: before launch, choose whether the launch API accepts legacy names as a supported v1 contract or labels them deprecated in docs with a target removal milestone.

## Proposed Follow-Up Task Breakdown

1. **API shim removal audit**
   - Owner: backend
   - Scope: remove `/sprints/:id/jobs` and `/sprints/:id/schedules` shims after UI/client usage check; update OpenAPI/docs.
   - Depends on: confirming no external clients still call these endpoints.

2. **Task relationship canonicalization**
   - Owner: backend
   - Scope: make `task_relationships` the only dependency/defect relation model; migrate blocker dispatch, read-model enrichment, defect filters, and spawned-defect metrics.
   - Depends on: data backfill validation and dispatcher tests.

3. **Evidence storage decision and migration**
   - Owner: backend + PM/operator
   - Scope: choose inline columns vs `custom_fields_json` vs `evidence_json`; remove duplicate read/write paths only after gates and MCP evidence tools are updated.
   - Depends on: lifecycle/release gate contract decision.

4. **Jobs-to-agents API naming cleanup**
   - Owner: backend + frontend
   - Scope: add agent-named request/query aliases, update UI/docs/contracts, then deprecate `job_id`, `job_title`, `job_instructions`, and sprint-scoped agent fields.
   - Depends on: API compatibility policy.

5. **Workflow/sprint terminology plan**
   - Owner: PM + backend + frontend
   - Scope: decide if DB remains `sprint_*` internally or if a staged schema/API rename is required; update contracts and OpenAPI accordingly.
   - Depends on: launch compatibility policy and migration appetite.

6. **Post-launch schema-init compatibility sweep**
   - Owner: backend
   - Scope: remove one-time migration/backfill code for deprecated sprint types, old routing config, old tool registry DDL, runtime lifecycle config scrubbers, old pre-instructions, and old schedules after production backup checks show no legacy rows/DDL.
   - Depends on: production data inventory.

## Suggested Data Checks Before Any Destructive Cleanup

Run against a production backup and both lease-managed Dev DBs:

```sql
SELECT COUNT(*) FROM sprints WHERE sprint_type IN ('bugs', 'enhancements', 'pm');
SELECT COUNT(*) FROM agents WHERE COALESCE(schedule, '') != '';
SELECT COUNT(*) FROM tasks WHERE origin_task_id IS NOT NULL OR COALESCE(defect_type, '') != '';
SELECT COUNT(*) FROM task_dependencies;
SELECT COUNT(*) FROM task_relationships WHERE relationship_type_key IN ('blocked_by', 'blocks', 'defect_of');
SELECT COUNT(*) FROM tasks WHERE COALESCE(review_branch, review_commit, qa_verified_commit, deployed_commit, live_verified_at, evidence_json) IS NOT NULL;
SELECT COUNT(*) FROM agents WHERE runtime_config LIKE '%lifecycleProxy%' OR runtime_config LIKE '%lifecycleMode%';
SELECT name, sql FROM sqlite_master WHERE sql LIKE '%routing_config_legacy%' OR sql LIKE '%job_templates%' OR sql LIKE '%pre_instructions%';
```

## Bottom Line

The launch-critical model is functional, but not slim. The safest launch posture is to document sprint/job/Atlas names as compatibility/internal vocabulary, remove the already-dead API shims, and defer relationship/evidence/jobs/workflow cleanup to explicit migration tasks with data checks and API versioning decisions.

---

## APPENDIX: Superseded F13 text from 3dc9283

**Appended during document recovery; not part of either original revision.**

The recovery audit cited this document at its creation commit 3dc9283. The body above is the later
8b234a8 revision, in which F13 was rewritten after task #743 landed the lane-metadata cleanup. The
original 3dc9283 wording of F13 is preserved here verbatim so the cited revision is fully recoverable
from this file:

> | F13 | `routing_config.lane` and workflow category/lane language | Compatibility shim still needed temporarily | Medium | `routing_config` includes `lane` at `api/src/db/schema.ts:1665`; contracts call workflow category `{{lane}}` at `agent-contracts/generic.md:20`; GitHub identities store `lane` in `api/src/lib/githubIdentity.ts:24` | Runtime contracts and identities still use lane/category role semantics | Product decision: either rename to workflow category/role everywhere or document lane as internal routing vocabulary. |

The corresponding superseded line under "Terminology Drift" read:

> - Agent contracts still expose `sprint_type` and `lane` as machine-readable fields (`agent-contracts/generic.md:19`).

Findings F1-F12 and F14-F15 are byte-identical between the two revisions.
