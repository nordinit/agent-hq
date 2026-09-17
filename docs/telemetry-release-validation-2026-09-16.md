# Telemetry release validation — September 16, 2026

The configurable telemetry changes were integrated onto remote main's workflow
environment setup release, `d15626ae`, before production deployment.

Validation of the combined code:

- API: all 241 suites and 2,455 tests passed in a full serialized run against
  disposable PostgreSQL databases; TypeScript and SQL portability lint passed.
- UI: all 233 tests and lint passed; the standalone production build passed.
- The compiled API production build passed.
- Headless browser acceptance passed seven scenarios against an isolated fixture:
  numeric totals and contributors; metric/report saves and snapshots; revision
  pinning; binding inheritance and disabling; first-pass denominators; invalid
  drafts; and independent project milestone measurements. No page errors occurred.
- A production backup was restored into a separate rehearsal database. Migrations
  26–30 applied successfully with migration 31 already present. The final ledger
  had no pending, drifted, or unexpected migrations. Operator configuration was
  unchanged by the migration command.

The first full API run exposed stale workflow-setup tests and a sprint-suite hook
timeout. The path-only dispatcher fixtures now mock the filesystem lease, and the
worktree test checks that repository creation does not install or share dependencies.
All three affected suites passed on retry, followed by the complete green run above.

The remote `mobile` MCP profile still exposes its existing 56 tools. This release
registers 30 telemetry tools in the full catalog; adding telemetry to the remote
profile and granting connector capabilities remain separate configuration work.

Migration installation begins durable capture. This validation does not imply a
production history backfill or activation of business metric definitions.
