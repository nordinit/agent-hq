# Workflow environment preparation and cleanup

Repository access and environment preparation are separate workflow settings.
Attaching a repository creates a task clone/worktree but no longer installs
packages. The workflow's `environment_setup` policy is the only switch that
authorizes preparation; workflow type, project type, `repo_required`, and legacy
agent repository settings do not implicitly enable it.

## Configuration

The workflow create/edit form, REST create/update endpoints, and MCP workflow
create/update tools accept the same policy. It is retained during workflow
copying and project export/import, validated on writes, and recorded in the
project audit log and successful dispatch payload.

- **Off**: `{ "mode": "off" }` (default).
- **Automatic**: detect the build tool in each explicitly selected folder.
- **Custom**: run an ordered list of executable/argument arrays, with a working
  directory for each command. This provides support for any codebase through
  its own setup script, task runner, or container command.

Example for separate API and UI packages:

```json
{
  "mode": "auto",
  "roots": ["api", "ui"],
  "timeoutSeconds": 600
}
```

Example for a repository that owns its toolchain and setup task through mise:

```json
{
  "mode": "custom",
  "steps": [
    { "command": ["mise", "install"], "cwd": "." },
    { "command": ["mise", "run", "setup"], "cwd": "." }
  ],
  "timeoutSeconds": 900
}
```

The executable must exist on the dispatch host. Custom commands can also invoke
`./scripts/setup`, Gradle, CMake, Conan, vcpkg, Docker, or any other project tool.
There is no implicit shell interpolation. To use shell syntax, explicitly invoke
a shell, such as `["sh", "-eu", "-c", "./configure && make dependencies"]`.
Paths must remain inside the repository; setup folders cannot escape through
symlinks. Commands themselves run with the host's normal permissions, just like
package install scripts. This feature is not a container sandbox.

## Automatic recipes

| Project manifests | Preparation |
| --- | --- |
| package.json + npm lock | npm ci |
| package.json + pnpm lock | pnpm install --frozen-lockfile |
| package.json + Yarn lock | Yarn immutable install, or frozen-lockfile for Classic |
| package.json + Bun lock | bun install --frozen-lockfile |
| pyproject.toml + uv.lock | uv sync --locked |
| pyproject.toml + poetry.lock | poetry install --no-interaction |
| requirements.txt | create a local .venv, then pip install |
| Cargo.toml + Cargo.lock | cargo fetch --locked |
| go.mod | go mod download |
| pom.xml | Maven dependency:go-offline (wrapper when present) |
| composer.json + composer.lock | composer install |
| Gemfile + Gemfile.lock | bundle install |
| Package.swift | swift package resolve |
| .NET project/solution | dotnet restore |

Automatic mode examines only selected folders, defaulting to the repository
root. It does not recursively walk every package manifest. A workspace-aware
package manager may prepare its declared workspace packages. Ambiguous build
systems or lockfiles require explicit component folders or Custom mode. Gradle
and C/C++ projects use Custom mode because resolving the necessary build targets
is project-specific.

Native package-manager download caches remain reusable. Mutable node_modules
are never linked between worktrees; legacy dependency symlinks produce an
explicit setup error instead of installing into another working copy. For
simple Node packages, a per-workspace fingerprint covers the setup policy,
manifest, lockfiles, relevant configuration, tool versions, OS, and architecture.
An unchanged installation can be reused if its local dependency directory still
exists. Workspace packages, local file dependencies, and other ecosystems rerun
the native restore/install command, allowing that tool to validate its cache and
full dependency graph. Custom steps always run and should be idempotent.

Python virtual environments, Bundler packages, and Composer vendor directories
are configured to stay local to the working copy. Missing tools and incompatible
requirements fail preparation. A pinned package-manager version must match.
Setup runs with NODE_ENV=development so a production API process does not
implicitly omit development dependencies. Automatic mode does not install system packages
through brew/apt. A Custom setup task can provision a project's toolchain.

Preparation is asynchronous and has a total timeout (default 10 minutes, maximum
1 hour). On timeout the runner kills its process group on Unix. A failed setup
blocks agent launch and records a startup failure. Raw package-manager output is
not copied into the task error; the error identifies the command and exit code.
A filesystem lease covers checkout, preparation, and dispatch linkage, preventing
concurrent cleanup. Changes to the task or workflow during setup cancel that
dispatch attempt.

## Cleanup

Both immediate task-lifecycle cleanup and the periodic workspace sweep use the
existing terminality resolver:

1. Global task-status defaults.
2. Workflow-type settings, with the owning tenant's row overriding shared rows.
3. Workflow-specific settings, including explicit non-terminal overrides.

There is no hardcoded list of task status names and no age-based deletion of a
non-terminal task's workspace. Terminal tasks wait for queued/dispatched/running
instances and preparation leases to finish. The sweep also finds clean orphaned
repositories after a 24-hour grace period.

Historical run paths and repository metadata remain available after a workflow
repo is detached. The sweep also visits agent workspace roots without requiring
current repo settings. Git metadata determines whether an orphan is a clone or
worktree, and worktrees are detached through Git. Failed detachment does not fall
back to recursive deletion.

Cleanup verifies a managed task repository before deleting it. Local changes,
untracked/ignored artifacts, unpublished commits, malformed folders, and contents
that cannot be verified are retained. Verified Git-ignored dependency directories
can still be reclaimed in a retained workspace. Agent HQ's own setup records and
matching run-context files do not prevent an otherwise clean checkout's removal.
Global tool caches are not deleted. Retention reasons appear in runtime logs.

## Rollout

Migration `31-workflow-environment-setup.sql` adds a JSONB setting with Off as the
default. It deliberately does not infer installation permission from a repo link
or `repo_required`; that inference caused the original space problem.

Before enabling the new dispatcher in a deployed environment:

1. Apply the migration with dispatch paused using the normal deployment process.
2. Explicitly configure Automatic or Custom setup for development workflows,
   selecting the appropriate folders. For Agent HQ, select `api` and `ui`.
3. Keep the Lead Generation workflow's repo detached and preparation Off.
4. Remove old shared dependency links from selected development workspaces before
   opting them into preparation; the runner will identify any remaining links.
5. Resume dispatch and verify one development run's setup result and one
   non-development run with no preparation.

The implementation branch does not change production configuration or restart
production services. Full devcontainer orchestration and automatic OS package
provisioning are future extensions; current Custom commands can invoke an
existing container workflow.

## Validation and references

Regression coverage includes settings persistence, validation and audit history;
workflow copy and project export/import; setup command selection, caching,
symlink boundaries, failure, timeout, and sequencing; dispatch cancellation after
configuration changes; configured terminal overrides; active runs and leases;
real clone/worktree cleanup; and retention of artifacts and unpublished commits.
The workflow form was exercised in a headless browser with simulated API responses.
External package registries were not used in automated tests. Validation passed:
111 regression tests across the affected suites, API TypeScript/SQL lint, the UI
production build, and browser form checks.

Relevant upstream command contracts:
[npm ci](https://docs.npmjs.com/cli/commands/npm-ci),
[pnpm install](https://pnpm.io/cli/install),
[Yarn install](https://yarnpkg.com/cli/install),
[uv sync](https://docs.astral.sh/uv/concepts/projects/sync/),
[Poetry configuration](https://python-poetry.org/docs/configuration/),
[Cargo fetch](https://doc.rust-lang.org/cargo/commands/cargo-fetch.html),
[Maven go-offline](https://maven.apache.org/plugins/maven-dependency-plugin/go-offline-mojo.html),
[Composer install](https://getcomposer.org/doc/03-cli.md#install-i),
[.NET restore](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-restore).
