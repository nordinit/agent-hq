# Contributing to Agent HQ

Thanks for contributing. Agent HQ is a task-routing and agent-orchestration system, so changes should optimize for predictable behavior, clear state transitions, and operator visibility.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Keep changes scoped. Small, reviewable PRs are easier to validate in this repo than broad mixed refactors.
- If the change affects workflow semantics, routing, or transcripts, include tests.

## Local development

### Requirements

- Node.js 22 (CI uses 22; the UI tests need 22.6 or newer)
- npm
- Git
- PostgreSQL 17. The API tests also need a role that can create databases (`CREATEDB`).
- Docker, only if you want to run the Compose stack

### Install

```bash
git clone https://github.com/nordinit/agent-hq.git
cd agent-hq
cp .env.example .env
```

In the repository-root `.env`, set:

- `DATABASE_URL` to a development database, for example `postgresql://user:password@127.0.0.1:5432/agent_hq_dev`
- `AGENT_HQ_OPERATOR_TOKEN` to the output of `openssl rand -hex 32`

Then install, build, and create the schema:

```bash
cd api
npm ci
npm run build
npm run db:install

cd ../ui
npm ci
```

`npm run db:install` installs the schema and, on an empty database, the starter records. Later schema changes are applied with `npm run db:migrate`; see [docs/database-migration-runbook.md](docs/database-migration-runbook.md).

### Run the app

Development servers:

```bash
# API: reads the repository-root .env
cd api && npm run dev

# UI: does not read the root .env, so pass the API address and the same token
cd ui && AGENT_HQ_INTERNAL_BASE_URL=http://localhost:3501 AGENT_HQ_OPERATOR_TOKEN=<token> npm run dev
```

Default ports:

- UI: `3500`
- API: `3501`

To try the packaged launcher from a checkout, run `node cli/bin/cli.js start` (or `npx @nordinit/agent-hq start` for the published version). Docker mode pulls the published images; `docker compose up --build -d` builds from your checkout instead.

## Tests and verification

Run the checks relevant to your change before opening a PR. CI runs all of them.

API:

```bash
cd api
npm run lint
AGENT_HQ_TEST_PG_URL=postgresql://user:password@127.0.0.1:5432/postgres npm test
npm run build
```

`AGENT_HQ_TEST_PG_URL` points at a PostgreSQL 17 server. Tests create their own disposable databases there and never use `DATABASE_URL`.

UI:

```bash
cd ui
npm run verify   # unit tests + lint
npm run build
```

CLI and OpenClaw plugin (no install needed):

```bash
npm run test:cli
cd plugins/openclaw-capability-tools && npm test
```

Terminology check (from the repository root):

```bash
node scripts/check-workflow-terminology.mjs
```

Agent HQ uses workflow terminology throughout. The check fails if the retired term for a workflow appears in application code, shipped skills, scripts, agent contracts, or the root README.

If your change only touches docs or templates, say so in the PR.

## Coding guidelines

- Prefer explicit behavior over clever abstractions.
- Preserve auditability. Task and run state should remain easy to reconstruct from persisted records.
- Schema changes go in a new numbered file under `db/pg-migrations/`. Never edit an applied migration: its checksum is recorded, and a changed file fails startup as drift.
- Do not introduce secrets, local machine paths, or environment-specific defaults into tracked files.
- Keep public docs and examples generic. Use placeholder domains, paths, and tokens.
- Add tests for behavior changes, especially around dispatch, routing, sessions, transcripts, and MCP/runtime integration.

## Pull requests

- Base branch: `main`
- Use a clear title that describes the behavior change.
- Include:
  - what changed
  - why it changed
  - how you verified it
  - any known limitations or follow-up work

## Issue reports

Good issue reports include:

- expected behavior
- actual behavior
- reproduction steps
- screenshots or logs when relevant
- environment details

## Contribution licensing

Agent HQ is licensed under the [MIT License](LICENSE), and contributions are accepted under the same license. By submitting a contribution, you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org): that you wrote it, or otherwise have the right to submit it under the MIT License. Sign off each commit with `git commit -s` to record that certification.

If AI tools helped write a contribution, you are responsible for having the right to submit what they produced.

## Security

Do not open public issues for credential disclosure, auth bypasses, or data-exposure bugs. Report them privately as described in [SECURITY.md](SECURITY.md).
