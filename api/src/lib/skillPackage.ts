export interface SkillPackageFile {
  path: string;
  content: string;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Validate a portable path inside a skill package.
 *
 * Paths are stored with POSIX separators regardless of the API host. Rejecting
 * traversal, empty segments, control characters, and Windows separators keeps
 * the same value safe when a runtime later materializes it on disk.
 */
export function normalizeSkillPackagePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 512) return null;
  if (candidate.startsWith('/') || candidate.includes('\\') || CONTROL_CHARACTER.test(candidate)) return null;

  const parts = candidate.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

/** Parse API package-file input while rejecting ambiguous or unsafe entries. */
export function parseSkillPackageFiles(value: unknown): SkillPackageFile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('files must be an array');

  const byPath = new Map<string, string>();
  for (const entry of value) {
    const filePath = normalizeSkillPackagePath((entry as any)?.path);
    const content = (entry as any)?.content;
    if (!filePath) throw new Error(`Invalid skill package file path: ${String((entry as any)?.path ?? '')}`);
    if (filePath === 'SKILL.md') throw new Error('SKILL.md must be supplied through the skill content field');
    if (typeof content !== 'string') throw new Error(`Skill package file content must be text: ${filePath}`);
    byPath.set(filePath, content);
  }

  return [...byPath].map(([path, content]) => ({ path, content }));
}
