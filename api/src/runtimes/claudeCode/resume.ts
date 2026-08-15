/**
 * Deciding whether a prior claude-code session can actually be continued.
 *
 * A chat turn asks to resume the session its previous turn ran under, but the
 * caller cannot know whether that session still exists on this machine: the
 * transcript may have been cleaned up, the agent's working directory may have
 * moved, or the run may have been recorded under a different Claude config home.
 * `--resume` against a session the CLI cannot find fails the whole dispatch, so
 * eligibility is checked here first and a miss simply falls back to a fresh
 * session — a turn without history is a far better outcome than a turn that
 * never starts.
 */

import fs from 'fs';
import path from 'path';

/** Claude Code stores each project's sessions under a slug of its absolute cwd. */
export function claudeProjectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[/\\.]/g, '-');
}

/** Where the CLI keeps the JSONL transcript for one session of one project. */
export function claudeSessionTranscriptPath(
  claudeConfigHome: string,
  cwd: string,
  sessionId: string,
): string {
  return path.join(claudeConfigHome, 'projects', claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

/**
 * The session id to continue, or null to start fresh.
 *
 * Resolved against the same project directory the run will execute in, because
 * that is the scope the CLI resumes within: a session recorded while the agent
 * pointed at another repo is not reachable from this one, and asking for it
 * would fail rather than silently start over.
 */
export function resolveResumableSessionId(params: {
  requested: string | null | undefined;
  cwd: string;
  claudeConfigHome: string;
}): string | null {
  const requested = typeof params.requested === 'string' ? params.requested.trim() : '';
  if (!isClaudeSessionId(requested)) return null;

  try {
    const transcriptPath = claudeSessionTranscriptPath(params.claudeConfigHome, params.cwd, requested);
    return fs.existsSync(transcriptPath) ? requested : null;
  } catch {
    // An unreadable config home is not a reason to fail the dispatch.
    return null;
  }
}
