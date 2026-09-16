-- Configurable reporting. Families, revisions, bindings and retained proofs share
-- tenant-owned storage; canonical workflow schemas remain the source of fields.
CREATE TABLE telemetry_definitions (
  id text PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('metric','profile','report')),
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  scope jsonb NOT NULL DEFAULT '{}',
  scope_key text NOT NULL,
  project_id bigint REFERENCES projects(id) ON DELETE CASCADE,
  latest_revision_id text,
  revision integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  validation_state text NOT NULL DEFAULT 'active' CHECK(validation_state IN ('active','draft')),
  validation_issues jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,kind,key,scope_key)
);
CREATE INDEX telemetry_definitions_scope ON telemetry_definitions(tenant_id,kind,project_id);
CREATE TABLE telemetry_definition_revisions (
  id text PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  definition_id text NOT NULL,
  revision integer NOT NULL,
  definition jsonb NOT NULL,
  dependencies jsonb NOT NULL DEFAULT '{}',
  hash text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,definition_id,revision),
  FOREIGN KEY (tenant_id,definition_id) REFERENCES telemetry_definitions(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE telemetry_definitions ADD CONSTRAINT telemetry_current_revision_fk
  FOREIGN KEY (tenant_id,latest_revision_id) REFERENCES telemetry_definition_revisions(tenant_id,id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE telemetry_metric_bindings (
  id text PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  family_key text NOT NULL,
  scope jsonb NOT NULL,
  scope_key text NOT NULL,
  project_id bigint REFERENCES projects(id) ON DELETE CASCADE,
  metric_revision_id text,
  profile_revision_id text,
  disabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  actor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,family_key,scope_key),
  FOREIGN KEY (tenant_id,metric_revision_id) REFERENCES telemetry_definition_revisions(tenant_id,id),
  FOREIGN KEY (tenant_id,profile_revision_id) REFERENCES telemetry_definition_revisions(tenant_id,id),
  CHECK (disabled OR metric_revision_id IS NOT NULL)
);
CREATE TABLE telemetry_binding_audit (
  id text PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  binding_id text NOT NULL,
  before_value jsonb,
  after_value jsonb NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,binding_id) REFERENCES telemetry_metric_bindings(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE telemetry_catalog_entries (
  id text PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  project_id bigint REFERENCES projects(id) ON DELETE CASCADE,
  descriptor jsonb NOT NULL,
  hash text NOT NULL,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id)
);
CREATE UNIQUE INDEX telemetry_catalog_live_source ON telemetry_catalog_entries(tenant_id,source_key) WHERE retired_at IS NULL;
CREATE TABLE telemetry_catalog_revisions (
  id text PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id text NOT NULL,
  descriptor jsonb NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,entry_id,hash),
  FOREIGN KEY (tenant_id,entry_id) REFERENCES telemetry_catalog_entries(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE telemetry_query_results (
  id text PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id bigint REFERENCES projects(id) ON DELETE CASCADE,
  scope jsonb NOT NULL DEFAULT '{}',
  request jsonb NOT NULL,
  request_hash text,
  result jsonb,
  state text NOT NULL CHECK (state IN ('queued','running','complete','failed','cancelled')),
  error jsonb,
  actor text NOT NULL,
  task_ids bigint[] NOT NULL DEFAULT '{}',
  source_projects bigint[] NOT NULL DEFAULT '{}',
  snapshot boolean NOT NULL DEFAULT false,
  report_revision_id text,
  claim_key text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '1 hour'),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,report_revision_id) REFERENCES telemetry_definition_revisions(tenant_id,id)
);
CREATE INDEX telemetry_query_results_expiry ON telemetry_query_results(tenant_id,expires_at);
CREATE INDEX telemetry_query_results_tasks ON telemetry_query_results USING gin(task_ids);
CREATE UNIQUE INDEX telemetry_query_results_active_request ON telemetry_query_results(tenant_id,request_hash)
  WHERE request_hash IS NOT NULL AND state IN ('queued','running');
CREATE TABLE telemetry_settings (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  query_retention_hours integer NOT NULL DEFAULT 1 CHECK(query_retention_hours BETWEEN 1 AND 168),
  snapshot_retention_days integer NOT NULL DEFAULT 30 CHECK(snapshot_retention_days BETWEEN 1 AND 365),
  max_snapshots integer NOT NULL DEFAULT 100 CHECK(max_snapshots BETWEEN 1 AND 1000),
  interactive_entities integer NOT NULL DEFAULT 10000 CHECK(interactive_entities BETWEEN 100 AND 50000),
  background_entities integer NOT NULL DEFAULT 50000 CHECK(background_entities BETWEEN 100 AND 50000),
  history_retention_days integer NOT NULL DEFAULT 90 CHECK(history_retention_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS telemetry_projects_tenant_identity ON projects(tenant_id,id);
ALTER TABLE telemetry_definitions ADD FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE telemetry_metric_bindings ADD FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE telemetry_catalog_entries ADD FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE;
ALTER TABLE telemetry_query_results ADD FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE;

-- A retained aggregate/proof cannot bypass deletion policy. Invalidate the entire
-- result, not just its detail rows, when any contributing task is hard-deleted.
CREATE FUNCTION telemetry_purge_task_results() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM telemetry_query_results WHERE tenant_id = OLD.tenant_id AND task_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;
CREATE TRIGGER telemetry_task_result_purge BEFORE DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION telemetry_purge_task_results();
