import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import fs from 'fs';
import path from 'path';
import { type Db } from "../db/adapter/types";
import { tableColumns as sharedTableColumns , listTables as sharedListTables } from "../db/introspection";

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitHubIdentity {
  id: number;
  tenant_id: number | null;
  github_username: string;
  token: string;
  git_author_name: string;
  git_author_email: string;
  lane: string;
  enabled: number;
}

export interface ResolvedGitHubIdentity {
  identity: GitHubIdentity;
  /** Whether this is a dedicated per-agent identity (true) or a shared fallback (false). */
  dedicated: boolean;
}

// ── Credential file names ────────────────────────────────────────────────────

/** File written to workspace root containing the GH_TOKEN for this run. */
const GH_TOKEN_FILE = '.atlas-gh-token';

/** File written to workspace root containing git identity env vars. */
const GH_IDENTITY_FILE = '.atlas-gh-identity.env';

function gitExec(args: string[], cwd: string): string {
  const opts: ExecFileSyncOptions = {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  return execFileSync('git', args, opts) as unknown as string;
}

function configureWorktreeGitIdentity(workingDirectory: string, identity: GitHubIdentity): boolean {
  try {
    const insideWorktree = gitExec(['rev-parse', '--is-inside-work-tree'], workingDirectory).trim();
    if (insideWorktree !== 'true') return false;

    // Linked task worktrees share the parent repository's local config. Enable
    // worktree-specific config so one agent's dispatch cannot overwrite the git
    // author used by another active worktree.
    gitExec(['config', 'extensions.worktreeConfig', 'true'], workingDirectory);
    gitExec(['config', '--worktree', 'user.name', identity.git_author_name], workingDirectory);
    gitExec(['config', '--worktree', 'user.email', identity.git_author_email], workingDirectory);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not a git repository')) return false;

    console.warn(
      `[githubIdentity] Failed to configure git author for ${identity.github_username} in ${workingDirectory}:`,
      message,
    );
    return false;
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * resolveGitHubIdentity — look up the GitHub identity for an agent.
 *
 * Precedence:
 *   1. agents.github_identity_id (direct FK — highest priority)
 *   2. Fallback: the first enabled github_identities row with lane='shared'
 *   3. null — no GitHub identity configured
 *
 * Returns null if no identity is found (agent should fall back to whatever
 * GH_TOKEN is in their environment from the host).
 */
export async function resolveGitHubIdentity(
  db: Db,
  agentId: number,
  tenantId?: number | null,
): Promise<ResolvedGitHubIdentity | null> {
  const tables = (await sharedListTables(db)).map((name) => ({ name }));
  const tableNames = new Set(tables.map(row => row.name));
  if (!tableNames.has('github_identities')) {
    return null;
  }

  const agentColumns = tableNames.has('agents')
    ? await sharedTableColumns(db, 'agents')
    : [];
  const hasAgentGithubIdentityId = agentColumns.includes('github_identity_id');
  const hasAgentTenantId = agentColumns.includes('tenant_id');
  const identityColumns = tableNames.has('github_identities')
    ? await sharedTableColumns(db, 'github_identities')
    : [];
  const hasIdentityTenantId = identityColumns.includes('tenant_id');

  const agent = hasAgentTenantId
    ? await db.get(`SELECT tenant_id FROM agents WHERE id = ? LIMIT 1`, agentId) as { tenant_id: number | null } | undefined
    : undefined;
  const resolvedTenantId = tenantId ?? agent?.tenant_id ?? null;

  // 1. Direct FK lookup
  if (hasAgentGithubIdentityId) {
    const direct = await db.get(`
      SELECT gi.*
      FROM agents a
      JOIN github_identities gi ON gi.id = a.github_identity_id
      WHERE a.id = ?
        AND gi.enabled = 1
        ${hasAgentTenantId && resolvedTenantId != null ? 'AND a.tenant_id = ?' : ''}
        ${hasIdentityTenantId && resolvedTenantId != null ? 'AND gi.tenant_id = ?' : ''}
    `, agentId, ...(hasAgentTenantId && resolvedTenantId != null ? [resolvedTenantId] : []), ...(hasIdentityTenantId && resolvedTenantId != null ? [resolvedTenantId] : [])) as GitHubIdentity | undefined;

    if (direct) {
      return { identity: direct, dedicated: true };
    }
  }

  // 2. Shared fallback
  const shared = await db.get(`
    SELECT * FROM github_identities
    WHERE lane = 'shared' AND enabled = 1
      ${hasIdentityTenantId && resolvedTenantId != null ? 'AND tenant_id = ?' : ''}
    ORDER BY id ASC
    LIMIT 1
  `, ...(hasIdentityTenantId && resolvedTenantId != null ? [resolvedTenantId] : [])) as GitHubIdentity | undefined;

  if (shared) {
    return { identity: shared, dedicated: false };
  }

  return null;
}

// ── Credential injection ─────────────────────────────────────────────────────

/**
 * injectGitHubCredentials — write GitHub token and git identity files to the
 * agent's working directory before dispatch.
 *
 * Files written:
 *   .atlas-gh-token        — plaintext PAT (mode 0600)
 *   .atlas-gh-identity.env — shell-sourceable env vars for git + gh CLI
 *   .git/config            — worktree-local user.name and user.email when cwd is a git worktree
 *
 * The agent's dispatch instructions tell them to:
 *   export GH_TOKEN=$(cat .atlas-gh-token)
 * or the OpenClaw hooks dispatch can inject it as an env var.
 *
 * Returns true if files were written successfully.
 */
export function injectGitHubCredentials(
  workingDirectory: string,
  identity: GitHubIdentity,
): boolean {
  try {
    // Write token file (restricted permissions)
    const tokenPath = path.join(workingDirectory, GH_TOKEN_FILE);
    fs.writeFileSync(tokenPath, identity.token, { mode: 0o600 });

    // Write identity env file
    const envPath = path.join(workingDirectory, GH_IDENTITY_FILE);
    const envContent = [
      `# Agent HQ GitHub identity — auto-generated, do not edit`,
      `# GitHub user: ${identity.github_username}`,
      `# Workflow role: ${identity.lane}`,
      `export GH_TOKEN="${identity.token}"`,
      `export GITHUB_TOKEN="${identity.token}"`,
      `export GIT_AUTHOR_NAME="${identity.git_author_name}"`,
      `export GIT_AUTHOR_EMAIL="${identity.git_author_email}"`,
      `export GIT_COMMITTER_NAME="${identity.git_author_name}"`,
      `export GIT_COMMITTER_EMAIL="${identity.git_author_email}"`,
      ``,
    ].join('\n');
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    const gitConfigured = configureWorktreeGitIdentity(workingDirectory, identity);

    console.log(
      `[githubIdentity] Injected credentials for ${identity.github_username}` +
      ` (lane: ${identity.lane}) into ${workingDirectory}` +
      `${gitConfigured ? ' and configured worktree git author' : ''}`
    );
    return true;
  } catch (err) {
    console.warn(`[githubIdentity] Failed to inject credentials into ${workingDirectory}:`, err);
    return false;
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * cleanupGitHubCredentials — remove injected credential files from workspace.
 * Called on dispatch failure or after run completion. Best-effort.
 */
export function cleanupGitHubCredentials(workingDirectory: string): void {
  for (const filename of [GH_TOKEN_FILE, GH_IDENTITY_FILE]) {
    try {
      const filePath = path.join(workingDirectory, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

// ── Dispatch message context ─────────────────────────────────────────────────

/**
 * buildGitHubIdentityContext — generate a context block for the agent's dispatch
 * message that tells them which GitHub identity to use.
 *
 * This block is appended to the dispatch message so the agent knows:
 *   - Which GitHub account they are operating as
 *   - Where to find the credential files
 *   - How to configure git + gh CLI for this identity
 *
 * Returns an empty string if no identity is resolved.
 */
export function buildGitHubIdentityContext(
  resolved: ResolvedGitHubIdentity | null,
  workingDirectory: string,
): string {
  if (!resolved) return '';

  const { identity, dedicated } = resolved;
  const identityNote = dedicated
    ? `You have a dedicated GitHub identity for this workflow role.`
    : `You are using a shared GitHub identity (no dedicated identity assigned).`;

  return [
    ``,
    `## GitHub Identity`,
    identityNote,
    `- **GitHub user:** ${identity.github_username}`,
    `- **Git author:** ${identity.git_author_name} <${identity.git_author_email}>`,
    `- **Workflow role:** ${identity.lane}`,
    ``,
    `### Credential setup`,
    `Agent HQ has already configured this worktree's local git author as ${identity.git_author_name} <${identity.git_author_email}>.`,
    `Before running any \`git commit\`, \`git merge\`, \`git cherry-pick\`, \`gh\`, or \`git push\` commands, source your GitHub credentials:`,
    '```bash',
    `source "${path.join(workingDirectory, GH_IDENTITY_FILE)}"`,
    '```',
    `This sets GH_TOKEN, GITHUB_TOKEN, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, and GIT_COMMITTER_EMAIL.`,
    `Before creating commits, verify identity with \`git config user.name\`, \`git config user.email\`, \`git var GIT_AUTHOR_IDENT\`, and \`git var GIT_COMMITTER_IDENT\`.`,
    ``,
    `Alternatively, read the token directly:`,
    '```bash',
    `export GH_TOKEN=$(cat "${path.join(workingDirectory, GH_TOKEN_FILE)}")`,
    '```',
    ``,
    `**Important:** Always use this identity for git commits and GitHub API calls during this run.`,
    ``,
  ].join('\n');
}
