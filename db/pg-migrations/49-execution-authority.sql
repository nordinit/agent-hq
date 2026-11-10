-- Additive, deliberately no automatic approvals or new grants for existing identities.
CREATE TABLE executable_secret_values (
  id text PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES tenants(id),
  digest text NOT NULL, value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,digest)
);
CREATE TABLE executable_revisions (
  id text PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES tenants(id),
  resource_kind text NOT NULL CHECK(resource_kind IN ('tool','mcp_server','agent_runtime','workflow_setup')),
  resource_id bigint NOT NULL, digest text NOT NULL, snapshot jsonb NOT NULL,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  published_by text, published_at timestamptz, revoked_at timestamptz,
  UNIQUE(tenant_id,resource_kind,resource_id,digest)
);
CREATE TABLE execution_bindings (
  id bigserial PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES tenants(id),
  subject_kind text NOT NULL CHECK(subject_kind IN ('agent','team')), subject_id bigint NOT NULL,
  resource_kind text NOT NULL, resource_id bigint NOT NULL,
  revision_id text NOT NULL REFERENCES executable_revisions(id), enabled integer NOT NULL DEFAULT 1,
  expires_at timestamptz, changed_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,subject_kind,subject_id,resource_kind,resource_id)
);
CREATE TABLE execution_audit (
  id bigserial PRIMARY KEY, tenant_id bigint NOT NULL REFERENCES tenants(id),
  actor text NOT NULL, action text NOT NULL, revision_id text,
  agent_id bigint, instance_id bigint, decision text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_bindings_subject ON execution_bindings(tenant_id,subject_kind,subject_id) WHERE enabled=1;
CREATE TABLE execution_credential_scopes (
  key_id bigint PRIMARY KEY REFERENCES mcp_api_keys(id), agent_id bigint NOT NULL REFERENCES agents(id),
  instance_id bigint NOT NULL REFERENCES job_instances(id), durable_run_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE FUNCTION protect_executable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.resource_kind IS DISTINCT FROM OLD.resource_kind OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.published_at IS NOT NULL AND (NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by))
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN RAISE EXCEPTION 'Executable revisions are immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER executable_revision_immutable BEFORE UPDATE OR DELETE ON executable_revisions FOR EACH ROW EXECUTE FUNCTION protect_executable_revision();
CREATE FUNCTION protect_execution_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Execution audit is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER execution_audit_immutable BEFORE UPDATE OR DELETE ON execution_audit FOR EACH ROW EXECUTE FUNCTION protect_execution_audit();
CREATE TRIGGER executable_secret_values_immutable BEFORE UPDATE OR DELETE ON executable_secret_values FOR EACH ROW EXECUTE FUNCTION protect_execution_audit();
