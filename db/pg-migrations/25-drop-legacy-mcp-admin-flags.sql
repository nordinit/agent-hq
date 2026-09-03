-- Migration 25: drop the legacy MCP admin flags.
--
-- Migration 24 moved MCP authority onto mcp_api_keys.role and read these two columns one last
-- time to backfill it. It left them in place so a rollback to the previous build would find what
-- it expected. Nothing reads them now, and a privilege column that still exists is a privilege
-- column someone will eventually write to and expect to work, so they go.
--
--   mcp_api_keys.global_admin   superseded by role = 'super_admin'
--   agents.global_mcp_admin     superseded by the same; authority is never an agent property now
--
-- THIS REMOVES THE ROLLBACK PATH FOR MIGRATION 24. The pre-24 build selects k.global_admin
-- unconditionally when resolving a key, so once these columns are gone that build cannot
-- authenticate any MCP request at all. Rolling back past this point means restoring the columns
-- first. Rolling forward is unaffected: role already carries everything they encoded.

ALTER TABLE mcp_api_keys DROP COLUMN IF EXISTS global_admin;
ALTER TABLE agents DROP COLUMN IF EXISTS global_mcp_admin;
