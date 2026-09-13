import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// A task folder is not necessarily disposable: outputs and unpublished commits
// often live next to the checkout. Only Git-ignored dependency directories with
// a corresponding manifest are expendable; arbitrary ignored files are kept.
export function prepareWorkspaceCleanup(workspace: string): { safe: boolean; reason?: string } {
  if (!path.isAbsolute(workspace) || !/^(?:task-|agent-hq-task-)\d+$/.test(path.basename(workspace))) return { safe: false, reason: 'Not a managed task workspace' };
  if (!fs.existsSync(workspace)) return { safe: true };
  if (fs.lstatSync(workspace).isSymbolicLink()) return { safe: false, reason: 'Workspace is a symlink' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  try {
    if (fs.realpathSync(git('rev-parse', '--show-toplevel').trim()) !== fs.realpathSync(workspace)) return { safe: false, reason: 'Workspace is not a repository root' };
    const status = git('status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal');
    const entries = status.split('\0').filter(Boolean);
    let hasWork = false;
    for (const entry of entries) {
      const name = entry.slice(3).replace(/\/$/, '');
      if (entry.startsWith('?? ') || entry.startsWith('!! ')) {
        if (name === '.agent-hq-setup') continue;
        if (name === '.agent-hq-run-context.json') {
          try {
            const context = JSON.parse(fs.readFileSync(path.join(workspace, name), 'utf8'));
            const taskId = Number(path.basename(workspace).match(/(\d+)$/)?.[1]);
            if (context.task_id === taskId && Number.isFinite(context.instance_id)) continue;
          } catch { /* unknown content is retained */ }
        }
      }
      const base = path.basename(name);
      const manifest = base === 'node_modules' ? 'package.json' : base === '.venv' ? 'pyproject.toml' : base === 'vendor' ? 'composer.json' : null;
      const target = path.resolve(workspace, name);
      const inside = target.startsWith(path.resolve(workspace) + path.sep);
      if (entry.startsWith('!! ') && manifest && inside
        && (fs.existsSync(path.join(path.dirname(target), manifest)) || (base === '.venv' && fs.existsSync(path.join(path.dirname(target), 'requirements.txt'))) || (base === 'vendor' && fs.existsSync(path.join(path.dirname(target), 'Gemfile'))))) {
        // Never follow a dependency or ancestor symlink out of the working copy.
        const parent = fs.realpathSync(path.dirname(target));
        if (parent === fs.realpathSync(workspace) || parent.startsWith(fs.realpathSync(workspace) + path.sep)) fs.rmSync(target, { recursive: true, force: true });
        else hasWork = true;
      } else hasWork = true;
    }
    if (hasWork) return { safe: false, reason: 'Retained workspace with local changes or artifacts; ignored dependencies reclaimed' };
    if (Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes').trim()) !== 0) return { safe: false, reason: 'Retained workspace with unpublished commits; ignored dependencies reclaimed' };
    return { safe: true };
  } catch {
    return { safe: false, reason: 'Could not verify workspace contents; retained for review' };
  }
}
