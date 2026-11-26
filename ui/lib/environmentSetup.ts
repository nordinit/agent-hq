/**
 * A workflow's environment preparation in plain words: what runs in a task's repository before
 * the agent starts. Shared by the workflow page and the Approvals page so both say the same thing.
 */
export interface EnvironmentSetupSummary {
  mode: 'off' | 'auto' | 'custom';
  label: 'Off' | 'Automatic' | 'Custom';
  description: string;
  /** Automatic: the project folders whose lockfiles are installed. */
  roots: string[];
  /** Custom: the commands, in order, and the folder each runs in. */
  steps: Array<{ command: string; cwd: string }>;
  timeoutSeconds: number | null;
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

/** Null when the value isn't an environment setup. An unset setup is Off. */
export function summarizeEnvironmentSetup(value: unknown): EnvironmentSetupSummary | null {
  const setup = value == null ? { mode: 'off' } : parse(value);
  if (!setup || typeof setup !== 'object') return null;
  const { mode, roots, steps, timeoutSeconds } = setup as { mode?: unknown; roots?: unknown; steps?: unknown; timeoutSeconds?: unknown };
  const timeout = typeof timeoutSeconds === 'number' ? timeoutSeconds : null;
  if (mode === 'off') {
    return { mode, label: 'Off', description: 'Nothing runs before the agent starts. The agent starts in its workspace as it is.', roots: [], steps: [], timeoutSeconds: null };
  }
  if (mode === 'auto') {
    const folders = Array.isArray(roots) && roots.length > 0 ? roots.map(String) : ['.'];
    const where = folders.length === 1 && folders[0] === '.' ? 'the repository' : folders.join(', ');
    return {
      mode, label: 'Automatic', roots: folders, steps: [], timeoutSeconds: timeout,
      description: `Agent HQ finds the project’s lockfile in ${where} and runs the matching install (for example npm ci or uv sync), skipping it when nothing changed.`,
    };
  }
  if (mode === 'custom') {
    const list = (Array.isArray(steps) ? steps : []) as Array<{ command?: unknown; cwd?: unknown }>;
    return {
      mode, label: 'Custom', roots: [], timeoutSeconds: timeout,
      description: 'Runs these commands in order, every time, before the agent starts:',
      steps: list.map(step => ({
        command: Array.isArray(step.command) ? step.command.map(String).join(' ') : String(step.command ?? ''),
        cwd: typeof step.cwd === 'string' && step.cwd ? step.cwd : '.',
      })),
    };
  }
  return null;
}
