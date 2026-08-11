import { buildGitHubIdentityContext, type ResolvedGitHubIdentity } from '../../../lib/githubIdentity';
import { type ContextSegmentDraft } from './contextBundle';

/**
 * The GitHub identity block as a bundle segment.
 *
 * Separator is '' on purpose. The block opens with its own newline and was historically
 * concatenated onto the contract with no join, so anything else here would change the bytes an
 * agent receives.
 */
export function buildGitHubIdentitySegmentDraft(
  resolved: ResolvedGitHubIdentity | null,
  workingDirectory: string | null,
): ContextSegmentDraft {
  const text = resolved && workingDirectory
    ? buildGitHubIdentityContext(resolved, workingDirectory)
    : '';

  return {
    kind: 'github_identity',
    label: 'GitHub Identity',
    text,
    separator: '',
    source: {
      type: 'github_identity',
      label: resolved ? resolved.identity.github_username : 'No identity injected',
      id: resolved?.identity.id ?? null,
      href: resolved ? '/settings?tab=github-identities' : null,
      detail: resolved
        ? {
          github_username: resolved.identity.github_username,
          git_author: `${resolved.identity.git_author_name} <${resolved.identity.git_author_email}>`,
          workflow_role: resolved.identity.lane,
          dedicated: resolved.dedicated,
          credential_directory: workingDirectory,
        }
        : undefined,
    },
    notInjectedReason: resolved
      ? 'Identity resolved but no active repo root existed to write credentials into'
      : 'No GitHub identity is assigned to this agent',
  };
}
