-- Keep the publication/revocation lock and all source-access checks, but resolve
-- canonical access once per mutation. The correlated EXISTS in migration 38
-- repeatedly scanned the complete source context for every retained proof.
CREATE OR REPLACE FUNCTION telemetry_invalidate_source(selected_tenant bigint, selected_type text, selected_id bigint, deleted boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF selected_tenant IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('telemetry-proof:'||selected_tenant::text,0));
  IF deleted THEN
    DELETE FROM telemetry_query_results q USING telemetry_query_sources s
      WHERE q.tenant_id=selected_tenant AND s.tenant_id=selected_tenant
        AND s.query_id=q.id AND s.source_type=selected_type AND s.source_id=selected_id;
    RETURN;
  END IF;
  WITH affected AS MATERIALIZED (
    SELECT DISTINCT query_id FROM telemetry_query_sources
      WHERE tenant_id=selected_tenant AND source_type=selected_type AND source_id=selected_id
  ), canonical AS MATERIALIZED (
    SELECT source_type,source_id,project_id FROM telemetry_source_context
      WHERE tenant_id=selected_tenant
  ), revoked AS MATERIALIZED (
    SELECT DISTINCT s.query_id FROM telemetry_query_sources s JOIN affected a USING(query_id)
      LEFT JOIN canonical c ON c.source_type=s.source_type AND c.source_id=s.source_id
      WHERE s.tenant_id=selected_tenant
        AND (c.source_id IS NULL OR c.project_id IS DISTINCT FROM s.project_id)
  )
  DELETE FROM telemetry_query_results q USING revoked r
    WHERE q.tenant_id=selected_tenant AND q.id=r.query_id;
END;
$$;
