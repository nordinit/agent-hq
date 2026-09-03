-- Migration 24: move MCP trust from the agent record onto the key that presents it.
--
-- Trust used to be derived from the agent row: resolveAgentIdentityFields treated an agent as
-- administrative when its system_role was 'admin' or 'atlas', or when its slug was 'atlas', or
-- when its NAME was literally 'Atlas'. A trusted agent resolves to the trusted_admin default
-- policy, under which nearly every capability including admin.full_access is enabled.
--
-- Every one of those inputs is an ordinary, writable column on agents. Any capability that could
-- edit an agent was therefore a latent privilege escalation — rename an agent to 'Atlas' and it
-- comes back an administrator — and the guard against that had to live in the authorization
-- layer, enumerating fields it was unsafe to write. That is the wrong shape: authority should
-- come from the credential presented, not from data the credential can edit.
--
-- After this, authority is a property of the KEY:
--
--   'scoped'      the default. Capability policy applies, nothing is implied.
--   'admin'       trusted: resolves to the trusted_admin default policy.
--   'super_admin' trusted, and additionally permitted across tenants.
--
-- The backfill preserves current effective access exactly rather than resetting anyone to
-- scoped, which would lock Atlas — and any other administrative identity — out of a running
-- system the moment this deploys. It reads the OLD rules once, here, and writes their result
-- onto each key. Nothing reads those agent columns for trust afterwards.

ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'scoped';

-- Super admin first, so the wider grant wins where a key qualifies for both. Both legacy inputs
-- count: global_admin on the key itself, and global_mcp_admin on the owning agent.
UPDATE mcp_api_keys k
SET role = 'super_admin'
WHERE k.global_admin = 1
   OR EXISTS (
     SELECT 1 FROM agents a
     WHERE a.id = k.agent_id
       AND COALESCE(a.global_mcp_admin, 0) = 1
   );

-- Then admin, for keys whose agent satisfied the old name/slug/system_role trust test.
UPDATE mcp_api_keys k
SET role = 'admin'
WHERE k.role = 'scoped'
  AND EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = k.agent_id
      AND (
        a.system_role IN ('atlas', 'admin')
        OR lower(COALESCE(a.slug, '')) = 'atlas'
        OR a.name = 'Atlas'
      )
  );

ALTER TABLE mcp_api_keys
  ADD CONSTRAINT mcp_api_keys_role_check
  CHECK (role IN ('scoped', 'admin', 'super_admin'));

CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_role ON mcp_api_keys (role) WHERE role <> 'scoped';

-- agents.global_mcp_admin and mcp_api_keys.global_admin are left in place, now read by nothing
-- in the trust path. They stay so this migration is reversible without data loss and so a
-- rollback to the previous build finds the columns it expects.
COMMENT ON COLUMN mcp_api_keys.role IS
  'Authority carried by this key: scoped (capability policy only), admin (trusted_admin default policy), or super_admin (also cross-tenant). The sole source of MCP trust — never derive it from the agent record.';
