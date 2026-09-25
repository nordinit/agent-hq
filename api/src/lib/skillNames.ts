/**
 * A skill name becomes a directory name when skills are materialized into an agent workspace
 * (`<workspace>/.claude/skills/<name>`, `<hermes home>/skills/<name>`, ...), and materialization
 * removes and replaces what it finds there. A name is therefore one plain path segment: it starts
 * with a letter or digit (so never `.`, `..` or a hidden file), and contains no separator or
 * control character. Letters, digits, spaces, dots, dashes and underscores cover every name the
 * product has created.
 */
const SKILL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,126}[A-Za-z0-9._-])?$/;

export function isSafeSkillName(value: unknown): value is string {
  return typeof value === 'string' && SKILL_NAME.test(value);
}

export const SKILL_NAME_RULE = 'Skill names must start with a letter or digit and contain only letters, digits, spaces, dots, dashes and underscores (max 128 characters).';
