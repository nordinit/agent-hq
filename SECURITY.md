# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/nordinit/agent-hq/security/advisories/new).
Please do not open a public issue, pull request, or discussion for a security problem.

Include the version or commit, how to reproduce the problem, and what an attacker could do with
it. We aim to acknowledge reports within a week and will keep you informed while a fix is
prepared. Credit is given in the advisory unless you ask otherwise.

## Supported versions

Agent HQ is pre-1.0. Security fixes land on `main` and in the next release; only the latest
release is supported.

## Security model

Understand these before exposing Agent HQ to anyone but yourself.

- **Operator access is shell access.** Agents run real CLIs (Claude Code, Codex, Hermes,
  OpenClaw) on the host, as the operating-system user that runs Agent HQ. Anyone who can
  operate Agent HQ can make it run commands on that host.
- **Every API request is authenticated.** `/api/v1` accepts the operator token
  (`AGENT_HQ_OPERATOR_TOKEN`, sent as `Authorization: Bearer <token>`) or an agent's MCP API key.
  Agent keys are limited to the capabilities granted to that agent. The UI signs in with the
  operator token and never sends it to the browser. See
  [Authentication](docs/SELF_HOSTING.md#authentication).
- **Loopback by default.** The API and UI listen on `127.0.0.1`, and browser requests from other
  origins are refused. Reach Agent HQ from another machine only through TLS (a reverse proxy or a
  tunnel).
- **Remote MCP connectors need only a few paths.** Publish `/mcp`,
  `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`,
  `/authorize`, `/oauth/consent`, `/token`, `/register` and `/revoke`. Never publish the whole API
  port. See [Remote transport](docs/agent-hq-mcp.md#remote-transport-streamable-http).
- **Agents share the operator's files.** An agent running as the same operating-system user can
  read anything that user can, including `.env` files that hold the operator token. For stronger
  isolation, run agents as separate users or in containers.

## Out of scope

- Actions an authenticated operator can take by design, such as defining tools, configuring
  runtimes, or running agents.
- Vulnerabilities in third-party agent CLIs or model providers. Report those to their vendors.
- Deployments that publish the API or UI to a network without TLS, contrary to the guidance above.
