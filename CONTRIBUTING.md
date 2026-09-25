# Contributing to Agent HQ

Thanks for contributing. Agent HQ is a task-routing and agent-orchestration system, so changes should optimize for predictable behavior, clear state transitions, and operator visibility.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Keep changes scoped. Small, reviewable PRs are easier to validate in this repo than broad mixed refactors.
- If the change affects workflow semantics, routing, or transcripts, include tests.

## Local development

### Requirements

- Node.js 18+
- npm
- Docker Desktop for the default stack, or a local Node-only workflow

### Install

```bash
git clone https://github.com/nordinit/agent-hq.git
cd agent-hq
cd api && npm install
cd ../ui && npm install
```

### Run the app

Docker:

```bash
npx agent-hq start
```

Local development:

```bash
cd api && npm run dev
cd ui && npm run dev
```

Default ports:

- UI: `3500`
- API: `3501`

## Tests and verification

Run the checks relevant to your change before opening a PR.

API:

```bash
cd api
npm run lint
npm test
npm run build
```

UI:

```bash
cd ui
npx tsc --noEmit
npm run build
```

If your change only touches docs or templates, say so in the PR.

## Coding guidelines

- Prefer explicit behavior over clever abstractions.
- Preserve auditability. Task and run state should remain easy to reconstruct from persisted records.
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

Recommended branch naming:

- `<author>/task-<id>-<short-slug>`
- Example: `forge/task-324-readme-docs`

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

Do not open public issues for credential disclosure, auth bypasses, or data-exposure bugs. Coordinate privately with the maintainers instead.
