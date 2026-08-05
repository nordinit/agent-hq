import type { CodexArgsInput, CodexReasoningEffort } from './types';
import {
  CODEX_DISABLED_AMBIENT_FEATURES,
  CODEX_FAST_MODE_FEATURE,
} from './policy';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function normalizeCodexReasoningEffort(
  value: string | null | undefined,
): CodexReasoningEffort | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return (value ?? '').trim().toLowerCase() as CodexReasoningEffort;
    default:
      return null;
  }
}

/** Agent HQ stores OpenAI model ids as `openai/<slug>`; the Codex CLI wants `<slug>`. */
export function normalizeCodexModel(value: string | null | undefined): string | null {
  const model = (value ?? '').trim();
  if (!model) return null;
  return model.startsWith('openai/') ? model.slice('openai/'.length) || null : model;
}

/** Build an exact `codex exec --json -` or `codex exec resume ... -` argv. */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const { config } = input;
  const args = ['exec'];

  // `--profile` belongs to the exec parent command in Codex 0.146.0 and is not
  // accepted after the `resume` subcommand. Select it before branching.
  if (input.configProfile) args.push('--profile', input.configProfile);
  if (config.resumeSessionId) args.push('resume');

  // Installed Codex 0.146 suppresses the selected v2 profile when
  // `--ignore-user-config` is present, which would silently remove assigned
  // MCP. Project/system config and capability-bearing user config are gated
  // separately; higher-precedence CLI policy remains pinned here.
  args.push('--json', '--strict-config', '--ignore-rules');
  for (const feature of CODEX_DISABLED_AMBIENT_FEATURES) {
    args.push('--disable', feature);
  }
  // `features.fast_mode` gates whether the `fast` service tier is honored.
  // Pin both values so a user-level service_tier cannot make the boundary lie.
  args.push(input.fastMode === true ? '--enable' : '--disable', CODEX_FAST_MODE_FEATURE);
  if (!config.resumeSessionId) args.push('--color', 'never');

  // These are config overrides rather than short flags because `exec resume`
  // does not expose --sandbox/--approval flags in Codex CLI 0.146.0.
  args.push('-c', `approval_policy=${tomlString(config.approvalPolicy)}`);
  args.push('-c', `sandbox_mode=${tomlString(config.sandboxMode)}`);
  args.push('-c', `service_tier=${tomlString(input.fastMode === true ? 'fast' : 'default')}`);
  args.push('-c', 'allow_login_shell=false');
  args.push('-c', `shell_environment_policy.inherit=${tomlString('core')}`);
  args.push('-c', 'shell_environment_policy.ignore_default_excludes=false');

  const effort = normalizeCodexReasoningEffort(input.reasoningEffort) ?? config.reasoningEffort;
  if (effort) args.push('-c', `model_reasoning_effort=${tomlString(effort)}`);

  const model = normalizeCodexModel(input.model) ?? normalizeCodexModel(config.model);
  if (model) args.push('--model', model);
  if (config.skipGitRepoCheck) args.push('--skip-git-repo-check');

  // Validated escape-hatch flags must precede positional SESSION_ID/PROMPT.
  args.push(...config.extraArgs.map((arg) => arg.trim()).filter(Boolean));
  if (config.resumeSessionId) args.push(config.resumeSessionId);
  args.push('-');
  return args;
}
