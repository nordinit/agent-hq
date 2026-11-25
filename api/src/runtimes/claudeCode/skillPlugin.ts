import fs from 'fs';
import path from 'path';
import {
  claudeCodeSkillPluginDir,
  claudeCodeSkillPluginManifestPath,
} from '../skillMaterialization';

/**
 * The `--plugin-dir` for a run, or null when it has no assigned skills.
 *
 * The dispatcher materializes the plugin before launch; this re-checks the
 * result so a run whose boundary promises skills never starts without them.
 * Every assigned name must have a readable `skills/<name>/SKILL.md`.
 */
export function resolveClaudeCodeSkillPluginDir(
  workingDirectory: string,
  skillNames: readonly string[],
): string | null {
  if (skillNames.length === 0) return null;
  const pluginDir = claudeCodeSkillPluginDir(workingDirectory);
  if (!fs.existsSync(claudeCodeSkillPluginManifestPath(workingDirectory))) {
    throw new Error(`Claude Code skills plugin is missing its manifest at ${pluginDir}`);
  }
  const missing = skillNames.filter((name) => {
    try {
      return !fs.statSync(path.join(pluginDir, 'skills', name, 'SKILL.md')).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(`Claude Code skills plugin at ${pluginDir} is missing assigned skills: ${missing.join(', ')}`);
  }
  return pluginDir;
}
