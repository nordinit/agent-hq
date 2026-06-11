'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Github,
  Loader2,
  RefreshCw,
  Save,
  XCircle,
} from 'lucide-react';
import { apiFetch, api, Agent } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GitHubIdentity {
  id: number;
  github_username: string;
  token: string; // masked on list endpoint (***xxxx)
  git_author_name: string;
  git_author_email: string;
  lane: string;
  enabled: number;
  validation_status: string | null;
  last_validated_at: string | null;
  validation_error: string | null;
  agent_count: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface AgentIdentityRow {
  agent: Agent;
  identity: GitHubIdentity | null;
  /** true = the agent was linked during this session's auto-create */
  justLinked?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string | null }) {
  if (!status || status === 'untested') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-zinc-400 bg-zinc-700/50 px-2 py-0.5 rounded-full">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
        Not validated
      </span>
    );
  }
  if (status === 'valid') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-400 bg-emerald-900/30 px-2 py-0.5 rounded-full">
        <CheckCircle2 className="w-3 h-3" />
        Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-red-400 bg-red-900/30 px-2 py-0.5 rounded-full">
      <XCircle className="w-3 h-3" />
      Failed
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SettingsGitHubPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [identities, setIdentities] = useState<GitHubIdentity[]>([]);
  const [agentRows, setAgentRows] = useState<AgentIdentityRow[]>([]);

  // PAT form state
  const [githubUsername, setGithubUsername] = useState('');
  const [pat, setPat] = useState('');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');
  const [showPat, setShowPat] = useState(false);

  // UI state
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    github_login?: string;
    error?: string;
  } | null>(null);

  // ── Load data ──────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [agentList, identityList] = await Promise.all([
        api.getAgents(),
        apiFetch<GitHubIdentity[]>('/api/v1/github-identities'),
      ]);
      setAgents(agentList);
      setIdentities(identityList);

      // Pre-fill form if a shared identity already exists
      const shared = identityList.find(i => i.lane === 'shared');
      if (shared) {
        setGithubUsername(shared.github_username);
        setGitAuthorName(shared.git_author_name);
        setGitAuthorEmail(shared.git_author_email);
        // Don't prefill token (masked), leave blank = no change
      }

      // Build agent rows
      const rows: AgentIdentityRow[] = agentList.map(agent => {
        if (!agent.github_identity_id) return { agent, identity: null };
        const identity = identityList.find(i => i.id === agent.github_identity_id) ?? null;
        return { agent, identity };
      });
      setAgentRows(rows);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Validate PAT ──────────────────────────────────────────

  const handleValidate = async () => {
    if (!pat || !pat.trim()) {
      setError('Enter a PAT to validate');
      return;
    }
    setValidating(true);
    setValidationResult(null);
    setError(null);
    try {
      // Validate by calling GitHub directly from the browser
      const resp = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${pat.trim()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!resp.ok) {
        setValidationResult({ valid: false, error: `GitHub returned ${resp.status}` });
      } else {
        const user = await resp.json() as { login: string; name?: string };
        setValidationResult({ valid: true, github_login: user.login });
        // Auto-fill username if blank
        if (!githubUsername) setGithubUsername(user.login);
        if (!gitAuthorName) setGitAuthorName(user.name ?? user.login);
        if (!gitAuthorEmail) setGitAuthorEmail(`${user.login}@users.noreply.github.com`);
      }
    } catch (err) {
      setValidationResult({ valid: false, error: String(err) });
    } finally {
      setValidating(false);
    }
  };

  // ── Save shared PAT + auto-create agent identities ────────

  const handleSave = async () => {
    if (!githubUsername.trim()) { setError('GitHub username is required'); return; }
    if (!pat.trim() && identities.length === 0) {
      setError('PAT is required for first-time setup');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const existingShared = identities.find(i => i.lane === 'shared');

      let sharedIdentity: GitHubIdentity;

      if (existingShared) {
        // Update existing shared identity
        const body: Record<string, string> = {
          github_username: githubUsername.trim(),
          git_author_name: gitAuthorName.trim() || githubUsername.trim(),
          git_author_email: gitAuthorEmail.trim() || `${githubUsername.trim()}@users.noreply.github.com`,
          lane: 'shared',
        };
        // Only send token if user typed a new one
        if (pat.trim()) body.token = pat.trim();

        sharedIdentity = await apiFetch<GitHubIdentity>(`/api/v1/github-identities/${existingShared.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        // Create new shared identity — token required here
        if (!pat.trim()) { setError('PAT is required'); setSaving(false); return; }
        sharedIdentity = await apiFetch<GitHubIdentity>('/api/v1/github-identities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            github_username: githubUsername.trim(),
            token: pat.trim(),
            git_author_name: gitAuthorName.trim() || githubUsername.trim(),
            git_author_email: gitAuthorEmail.trim() || `${githubUsername.trim()}@users.noreply.github.com`,
            lane: 'shared',
          }),
        });
      }

      // Auto-assign shared identity to all agents that don't already have one
      const agentsWithoutIdentity = agents.filter(a => !a.github_identity_id);
      let linked = 0;
      await Promise.all(
        agentsWithoutIdentity.map(async (agent) => {
          try {
            await apiFetch(`/api/v1/agents/${agent.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ github_identity_id: sharedIdentity.id }),
            });
            linked++;
          } catch {
            // Best-effort per agent
          }
        })
      );

      setSuccessMsg(
        linked > 0
          ? `Saved. Linked shared identity to ${linked} agent(s).`
          : 'Saved. Identity updated.',
      );
      setPat(''); // Clear PAT field after save
      await loadData(); // Refresh all data
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  // ── Disconnect agent ──────────────────────────────────────

  const handleDisconnect = async (agentId: number) => {
    try {
      await apiFetch(`/api/v1/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github_identity_id: null }),
      });
      await loadData();
    } catch (err) {
      setError(String(err));
    }
  };

  // ── Revalidate an identity via API ────────────────────────

  const handleRevalidate = async (identityId: number) => {
    try {
      await apiFetch(`/api/v1/github-identities/${identityId}/validate`, { method: 'POST' });
      await loadData();
    } catch (err) {
      setError(String(err));
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  const sharedIdentity = identities.find(i => i.lane === 'shared');

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-zinc-800 border border-zinc-700">
          <Github className="w-5 h-5 text-zinc-300" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">GitHub Integration</h2>
          <p className="text-sm text-zinc-400">
            Configure a shared Personal Access Token for all agents. Agents use this to open PRs,
            approve, and merge via the GitHub API.
          </p>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-900/20 border border-red-700/40 text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}
      {successMsg && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-900/20 border border-emerald-700/40 text-emerald-300 text-sm">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          {successMsg}
        </div>
      )}

      {/* Shared PAT form */}
      <div className="rounded-xl border border-zinc-700/60 bg-zinc-800/50 p-6 space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-white mb-1">Shared PAT</h3>
          <p className="text-xs text-zinc-400">
            A single PAT shared across all agents. On save, any agent without an assigned GitHub
            identity will be auto-linked to this shared credential.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">GitHub Username</label>
            <input
              type="text"
              value={githubUsername}
              onChange={e => setGithubUsername(e.target.value)}
              placeholder="octocat"
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-white text-sm
                         placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">
              Personal Access Token{sharedIdentity ? ' (leave blank to keep existing)' : ''}
            </label>
            <div className="relative">
              <input
                type={showPat ? 'text' : 'password'}
                value={pat}
                onChange={e => setPat(e.target.value)}
                placeholder={sharedIdentity ? '••••••••••••' : 'ghp_...'}
                className="w-full px-3 py-2 pr-9 rounded-lg bg-zinc-900 border border-zinc-700 text-white text-sm
                           placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60"
              />
              <button
                type="button"
                onClick={() => setShowPat(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              >
                {showPat ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Git Author Name</label>
            <input
              type="text"
              value={gitAuthorName}
              onChange={e => setGitAuthorName(e.target.value)}
              placeholder="Atlas Agents"
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-white text-sm
                         placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Git Author Email</label>
            <input
              type="email"
              value={gitAuthorEmail}
              onChange={e => setGitAuthorEmail(e.target.value)}
              placeholder="agents@example.com"
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-white text-sm
                         placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60"
            />
          </div>
        </div>

        {/* Validation result */}
        {validationResult && (
          <div
            className={`flex items-center gap-2 text-sm p-2.5 rounded-lg ${
              validationResult.valid
                ? 'bg-emerald-900/20 border border-emerald-700/40 text-emerald-300'
                : 'bg-red-900/20 border border-red-700/40 text-red-300'
            }`}
          >
            {validationResult.valid ? (
              <>
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                Token valid — authenticated as{' '}
                <strong className="font-semibold">{validationResult.github_login}</strong>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4 shrink-0" />
                {validationResult.error ?? 'Token invalid'}
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleValidate}
            disabled={validating || !pat.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-600 text-zinc-300
                       text-sm hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {validating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Validate token
          </button>

          <button
            onClick={handleSave}
            disabled={saving || !githubUsername.trim()}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400
                       text-black font-medium text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {sharedIdentity ? 'Save changes' : 'Save & link agents'}
          </button>
        </div>
      </div>

      {/* Agent connection status */}
      <div className="rounded-xl border border-zinc-700/60 bg-zinc-800/50 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-700/40 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Agent Connections</h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Per-agent GitHub identity status.{' '}
              {sharedIdentity
                ? 'Agents without a dedicated identity use the shared PAT above.'
                : 'Save a shared PAT to auto-link all agents.'}
            </p>
          </div>
          <button
            onClick={loadData}
            className="p-1.5 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        <div className="divide-y divide-zinc-700/30">
          {agentRows.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-zinc-500">No agents found.</div>
          )}
          {agentRows.map(({ agent, identity, justLinked }) => (
            <div key={agent.id} className="px-5 py-3.5 flex items-center gap-3">
              {/* Avatar placeholder */}
              <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center shrink-0">
                <span className="text-xs font-semibold text-zinc-300">
                  {(agent.name ?? '?')[0].toUpperCase()}
                </span>
              </div>

              {/* Agent info */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">{agent.name}</div>
                <div className="text-xs text-zinc-500 truncate">{agent.role ?? agent.session_key}</div>
              </div>

              {/* Identity info */}
              {identity ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-zinc-400 hidden sm:inline">
                    {identity.github_username}
                  </span>
                  <StatusBadge status={identity.validation_status} />
                  {identity.validation_status === 'valid' || identity.validation_status == null ? null : (
                    <button
                      onClick={() => handleRevalidate(identity.id)}
                      className="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
                    >
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => handleDisconnect(agent.id)}
                    className="ml-1 text-xs text-zinc-500 hover:text-red-400 transition-colors"
                    title="Disconnect GitHub identity"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="shrink-0">
                  {sharedIdentity ? (
                    <span className="text-xs text-zinc-500">Not linked</span>
                  ) : (
                    <span className="text-xs text-zinc-600 italic">No identity</span>
                  )}
                </div>
              )}

              {justLinked && (
                <span className="text-xs text-amber-400 font-medium shrink-0">Just linked</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* PAT scope hint */}
      <div className="rounded-lg border border-zinc-700/40 bg-zinc-800/30 px-4 py-3">
        <p className="text-xs text-zinc-500">
          <span className="font-medium text-zinc-400">Required token scopes:</span>{' '}
          <code className="px-1 py-0.5 bg-zinc-700 rounded text-zinc-300">repo</code>{' '}
          (for private repos), or{' '}
          <code className="px-1 py-0.5 bg-zinc-700 rounded text-zinc-300">public_repo</code>{' '}
          for public-only. Fine-grained tokens: Contents (read/write), Pull requests (read/write), Metadata (read).
        </p>
      </div>
    </div>
  );
}
