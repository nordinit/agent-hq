# Replace Agent HQ MCP profiles with identity permissions

Status: Draft for review, September 18, 2026. This replaces the earlier proposal to store MCP profiles in the database. It does not implement the change or alter live access.

The target model is: an authenticated identity has permissions, those permissions determine which Agent HQ tools it sees, and every operation is checked against the identity's permitted scope. There are no configurable tool profiles, profile assignments, profile tables, or profile editor.

1. **Keep identity, permissions, and tool implementation as the model.**

   Keep existing agent identities, MCP keys, OAuth grants, tenant/project membership, and `agent_mcp_capability_policies`. Keep tool implementations and their input schemas in the registered code catalog. Keep the existing capability catalog and request authorization rules.

   An agent's Agent HQ MCP Access panel remains the place to configure its access. Selecting a capability changes its permitted operations and automatically changes the tools offered by Agent HQ. Scope descriptions must reflect the actual implemented rules: for example, active dispatched task access is not necessarily the same as access to every task assigned to an agent. This change does not introduce new tenant-wide CRUD permissions or change task ownership rules.

   Remove the `full` and `mobile` MCP visibility profiles and their paired provisioning policies. This applies only to Agent HQ MCP tool profiles; telemetry profiles, model/provider profiles, external MCP server assignments, and unrelated runtime configuration are separate features.

2. **Define permission requirements for every registered tool.**

   Extend MCP tool registration metadata with explicit capability requirements for discovery. Represent alternatives and combinations where needed: a tool may be available through either an active-task capability or a project capability, while another tool may require multiple capabilities.

   Do not infer access from the tool name, domain, or `rest_paths`. Current route mappings omit HTTP methods and do not describe all conditional authorization paths. Audit each tool's actual API calls and middleware branches, including workflow lifecycle operations, task evidence, definition reads and writes, and administrative tools. Administrative bypass behavior must match the existing authorization layer.

   Require discovery metadata for every registered tool. A missing declaration must fail catalog validation and remain unexposed at runtime. Maintain a test that compares registered tools with permission declarations. Generic API fallback tools need an explicit reviewed declaration; the wildcard `/api/v1/*` mapping is not an access rule.

   Discovery means that an identity has a legitimate permitted use of a tool. It does not promise that arbitrary arguments, projects, tasks, or lifecycle states will be accepted. Continue enforcing those conditions at execution time.

3. **Build one resolver for effective access.**

   Factor out a shared resolver that takes the authenticated MCP identity and presented key and returns effective capabilities, matching tools, a deterministic policy fingerprint, and useful scope descriptions. Use the same capability-resolution semantics as `authorizeMcpApiRequestIfPresent`.

   Resolve trust from the presented key. Do not use an identity-summary endpoint that reports the strongest role among the agent's keys: an agent may hold both scoped and administrative keys, and the scoped key must not inherit the other's authority.

   Provide an authenticated effective-access API for a caller to read its own tool metadata. This read must work even when the caller has no optional catalog-read grant, without exposing other identities or project data. Use a separate operator preview endpoint for inspecting another identity's access; identify any key-role-dependent differences in that preview.

   Derive the fingerprint from effective policy and catalog metadata, rather than relying only on timestamps. A revoked/disabled credential or unavailable permission lookup must never cause a fallback to the complete tool catalog.

4. **Use effective access in both MCP transports.**

   For HTTP, authenticate each request and resolve the current effective tool set before building the per-request MCP server. Register that set for `tools/list` and `tools/call`. Keep the existing per-key rate limit, OAuth flow, tenant handling, and API authorization.

   For stdio, fetch effective access through the authenticated Agent HQ API, using the existing API URL and key. Do not give MCP client processes database credentials. Refresh the registered tool set for discovery and revalidate access before calls; keep current REST authorization as the final check. Use the MCP SDK's tool-list change notification when the long-lived connection supports it. A removed permission must block subsequent operations even if the client still has an old tool list.

   Keep the complete product catalog for operator documentation and tests. Do not let a caller-specific server overwrite that shared catalog. Make the caller-facing `agent-hq://catalog` resource consistent with effective tool discovery, and review other resources for the same permissions and tenant boundaries.

   Replace profile names in transport diagnostics with identity, policy fingerprint, tool count, and the existing catalog fingerprint. Do not log credentials, arguments, or result contents.

5. **Make the existing access UI explain the result.**

   Enhance Agent HQ MCP Access to show each capability's actual scope, the resulting available tool count/list, and why a tool is unavailable. Use backend-computed results rather than a second permission implementation in the UI. Support previewing unsaved permission changes without persisting them.

   Save permissions using the existing API. Do not add a profile selector, profile screen, hidden tool-membership list, or automatic permission grant. Keep the current controls for who may edit permission policies, including restrictions on self-escalation and administrative capabilities.

   Explain that access changes take effect on the server after saving; a connector may need a tool-metadata refresh or a new conversation before it discovers additions. Refreshing is a client-discovery step, not a requirement for enforcing permission revocations.

6. **Preserve current policies and remove configuration dependencies.**

   Before rollout, capture effective capability snapshots and compare the old and proposed tool lists for existing identities. Explicitly include ChatGPT Mobile, Claude Mobile, Casper, and James. Preserve all saved capability policies and key roles. Both mobile identities keep project-scoped workflow-definition management, and `admin.full_access` stays disabled.

   The expected visibility change is intentional: tools that were hidden by a profile but already authorized by a capability become visible, and tools that an identity could see but never use disappear. Review those differences instead of claiming the old and new tool lists will be identical. Do not enable permissions merely to preserve a formerly visible tool.

   Audit Agent HQ-specific assignment-level tool filters as another possible source of hidden visibility restrictions. Remove redundant filters. Where an explicit restrictive filter exists, translate it only when the existing capabilities can express the same restriction; otherwise document the exact access difference for resolution before rollout. Preserve unrelated external-server assignment and filtering behavior.

   Replace `provision-remote-mcp-identity --profile` with explicit capability input or a permissions file. Rerunning identity/credential provisioning must preserve the current policy unless permission replacement was explicitly requested. New identities should have an explicit minimal policy, and provisioning must not mint administrative authority by default. Do not replace profiles with automatically applied named permission bundles in this work.

   Remove `AGENT_HQ_MCP_TOOL_PROFILE` and `AGENT_HQ_MCP_HTTP_TOOL_PROFILE` from maintained configuration and generated client settings. During transition, detect legacy values and emit a clear deprecation notice; never treat `full` as an instruction to bypass permission filtering. Inventory and update script callers that still pass `--profile`, with a clear CLI migration error for obsolete arguments.

   Delete `toolProfiles.ts`, profile-only tests, and profile wiring in the registrar, server factory, transports, provisioning script, logs, and documentation once their replacements are in place. No profile database migration or OAuth reconnection/key rotation is required by this design.

7. **Test authorization and discovery together.**

   Test HTTP and stdio with identical credentials and confirm the same tool metadata and permission decisions. Cover read-only identities, active-task access, project-scoped task management, workflow-definition management, compound/alternative capabilities, and existing administrative access.

   Verify allowed operations and rejected calls on other tasks, projects, and tenants. Check that tools omitted from discovery cannot be invoked successfully with an unauthorized identity, and that REST calls cannot bypass scope checks. Test an agent with both scoped and administrative keys to confirm no authority leaks between them.

   Test live permission grants/revocations without an API restart, stale client tool lists, policy lookup failures, disabled identities, revoked keys, new registered tools with missing declarations, and separation of the global documentation catalog from caller-specific resources. Verify provisioning does not overwrite existing policies implicitly.

   Add UI coverage for permission changes and backend-derived tool previews. Replace fixed mobile/full counts with assertions against each fixture identity's effective policy. Reuse the existing API authorization tests and add integration coverage where tools call multiple endpoints or select different operations from arguments.

8. **Roll out and verify the simplification.**

   Deliver in order: permission metadata/shared resolver; HTTP and stdio integration; provisioning/UI/documentation cleanup; removal of profile code. These are implementation stages, not separate permanent access models.

   Deploy a matched API and local MCP build. Existing stdio processes need a one-time restart to load the new implementation; subsequent permission edits must not require server restarts. Refresh remote connector tool metadata and verify task/schema operations with actual scoped test identities in an isolated environment. In production, verify permission readback and authenticated tool discovery without modifying business tasks or definitions for a smoke test.

   Acceptance: an operator edits an identity's permissions in one UI screen, the identity's tool list follows those permissions, and every call remains bounded by its scope. Casper, James, ChatGPT Mobile, and Claude Mobile retain separate identities and audit histories, with no profile selection anywhere in the Agent HQ MCP configuration.

   Keep the prior build and policy snapshots for rollback. Avoid capability rewrites during this rollout so reverting the application does not require reconstructing identities or permissions.

Relevant implementation entry points: `api/src/lib/mcpApiAuth.ts`, `api/src/mcp/registrar.ts`, `api/src/mcp/catalog.ts`, `api/src/mcp/registerCatalog.ts`, `api/src/mcp/serverFactory.ts`, `api/src/mcp/httpServer.ts`, `api/src/mcp/server.ts`, `api/src/mcp/domains/resources.ts`, `api/src/bin/provision-remote-mcp-identity.ts`, and `ui/app/agents/[id]/page.tsx`.
