# MCP identity permissions rollout — 2026-09-18

Deployed to the running Agent HQ API/UI at `https://hq.nordinit.com` and the local MCP build in `api/dist`. MCP visibility profiles have been removed. Saved identity capabilities now determine tool discovery and execution; REST continues to enforce resource, tenant, project and active-run scope.

No identity policies or credentials were rewritten or rotated during this rollout. Future permission edits use the existing database policy and require no deployment.

| Identity | Previously advertised | Now permitted | Admin full access |
| --- | ---: | ---: | --- |
| James | 217 | 38 | Disabled |
| Casper | 217 | 87 | Disabled |
| Claude Mobile | 115 | 123 | Disabled |
| ChatGPT Mobile | 115 | 123 | Disabled |

These counts reflect saved permissions on the rollout date, not permanent tool bundles. Mobile identities retain workflow-definition read and manage permissions. Their lists now include nine previously hidden permitted tools and omit the administrative transition-field listing. No additional authority was granted.

Validation completed:

- Full MCP suite; API authorization and policy routes; provisioning preservation; MCP materialization tests.
- API TypeScript build and UI production build. UI build reports existing unrelated lint warnings.
- Isolated database tests for real workflow type, task type and schema CRUD, cross-project/cross-tenant denials, permission grants/revocations without reconnecting, disabled identities, expired/revoked keys and separate key roles on one identity.
- Production readback of all four policies matched pre-deployment snapshots exactly.
- Authenticated public HTTP and fresh stdio discovery matched for Casper and James using their existing scoped credentials. Mobile tool lists were checked through the backend's saved-policy preview; their OAuth tokens were not available for a direct client-side refresh.
- Deployed UI showed 123 available mobile tools. An unsaved removal of definition management showed 107 tools and the correct unavailable reason. Reload discarded the draft and restored 123; no permission save was performed.

Existing long-lived stdio processes need one reconnect to load the new implementation. Active agent app-server sessions were left running to avoid interrupting work. Later permission edits are checked before every list/call/resource read. ChatGPT and Claude may need a tool-metadata refresh to display the new list; reconnecting OAuth or rotating keys is not required.

Rollback artifacts are at `/private/tmp/agent-hq-identity-permissions-backup-gXtrg3`: previous release API build, local API build, UI build, affected sources, policy snapshots and `rollback-manifest.json`. Deployment details are in `/private/tmp/agent-hq-identity-permissions-deployment.json`. Policies need no rollback because this rollout did not change them.
