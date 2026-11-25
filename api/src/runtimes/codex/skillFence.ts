import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Codex's native skill delivery is its "Available skills" listing: each skill's
 * name, description and SKILL.md path go into the developer prompt, and the
 * model reads the file when a task matches. Agent HQ copies an agent's assigned
 * skills into `<cwd>/.agents/skills` (CodexSkillAdapter) and turns the listing
 * on with `skills.include_instructions=true`.
 *
 * The listing is not limited to that folder. Verified on Codex 0.167.2 with
 * `codex debug prompt-input`, it also includes every SKILL.md under:
 *   - `<dir>/.agents/skills` and `<dir>/.codex/skills` for each directory from
 *     cwd up to the git root (only cwd itself outside a repository);
 *   - `$CODEX_HOME/skills` (the agent's credential home, possibly `~/.codex`);
 *   - `$HOME/.agents/skills` (host-wide, e.g. skills synced by desktop apps);
 *   - `/etc/codex/skills`.
 * Bundled system skills are off separately (`skills.bundled.enabled=false`).
 *
 * Codex cannot switch off a whole root: a `skills.config` entry disables one
 * SKILL.md by path (a directory path or a parent root has no effect). So this
 * module walks those roots and returns the path of every SKILL.md that is not
 * an assigned skill, for buildCodexArgs to disable one by one. A path that no
 * longer exists, or appears twice, is accepted and ignored by Codex.
 */

const MAX_DEPTH = 8;
const MAX_VISITED_DIRECTORIES = 5000;
const MAX_DISABLED_SKILLS = 500;

export interface CodexSkillFenceInput {
  cwd: string;
  codexHome: string;
  /** HOME of the Codex child process. */
  homeDir: string | null | undefined;
  /** Skills materialized in `<cwd>/.agents/skills/<name>`; these stay listed. */
  assignedSkillNames: readonly string[];
  /** Admin root; overridable for tests. */
  systemSkillsDir?: string | null;
}

export interface CodexSkillFence {
  /** Every unassigned SKILL.md Codex would list, as absolute paths. */
  disabledSkillPaths: string[];
  /** The roots that were walked, for logs and tests. */
  roots: string[];
  /**
   * False when the walk hit a size limit, so some unassigned skill may remain
   * listed. The caller then keeps the listing off rather than show ambient skills.
   */
  complete: boolean;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function findGitRoot(start: string): string | null {
  let current = start;
  while (true) {
    try {
      fs.lstatSync(path.join(current, '.git'));
      return current;
    } catch { /* keep climbing */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function codexSkillRoots(input: CodexSkillFenceInput): string[] {
  const cwd = path.resolve(input.cwd);
  const stopAt = findGitRoot(cwd) ?? cwd;
  const roots: string[] = [];
  let current = cwd;
  while (true) {
    roots.push(path.join(current, '.agents', 'skills'), path.join(current, '.codex', 'skills'));
    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  roots.push(path.join(path.resolve(input.codexHome), 'skills'));
  const home = (input.homeDir ?? '').trim() || os.homedir();
  if (home) roots.push(path.join(path.resolve(home), '.agents', 'skills'));
  const systemDir = input.systemSkillsDir === undefined
    ? (process.platform === 'win32' ? null : '/etc/codex/skills')
    : input.systemSkillsDir;
  if (systemDir) roots.push(systemDir);
  return [...new Set(roots)];
}

export function buildCodexSkillFence(input: CodexSkillFenceInput): CodexSkillFence {
  const roots = codexSkillRoots(input);
  const assignedDirs = new Set(
    input.assignedSkillNames.map((name) => path.join(path.resolve(input.cwd), '.agents', 'skills', name)),
  );
  const disabled = new Set<string>();
  const seenRealDirs = new Set<string>();
  let visited = 0;
  let complete = true;

  const addDisabled = (skillFile: string): void => {
    disabled.add(skillFile);
    try {
      // Also name the resolved path in case Codex canonicalizes a symlinked root.
      const real = fs.realpathSync(skillFile);
      if (real !== skillFile) disabled.add(real);
    } catch { /* dangling link: Codex cannot list it either */ }
  };

  const walk = (dir: string, depth: number): void => {
    if (!complete) return;
    if (assignedDirs.has(dir)) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seenRealDirs.has(real)) return;
    seenRealDirs.add(real);
    visited += 1;
    if (visited > MAX_VISITED_DIRECTORIES) {
      complete = false;
      return;
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes('SKILL.md')) {
      const skillFile = path.join(dir, 'SKILL.md');
      try {
        if (fs.statSync(skillFile).isFile()) addDisabled(skillFile);
      } catch { /* unreadable: not listable */ }
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries.sort()) {
      const child = path.join(dir, entry);
      if (isDirectory(child)) walk(child, depth + 1);
    }
  };

  for (const root of roots) {
    if (isDirectory(root)) walk(root, 0);
  }

  const disabledSkillPaths = [...disabled].sort();
  if (disabledSkillPaths.length > MAX_DISABLED_SKILLS) complete = false;
  return {
    disabledSkillPaths: complete ? disabledSkillPaths : [],
    roots,
    complete,
  };
}
