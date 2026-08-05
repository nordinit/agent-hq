import { normalizeSkillPackagePath, parseSkillPackageFiles } from './skillPackage';

describe('skill package paths', () => {
  it('accepts portable nested relative paths', () => {
    expect(normalizeSkillPackagePath('references/setup/guide.md')).toBe('references/setup/guide.md');
  });

  it.each([
    '/absolute.md',
    '../escape.md',
    'references/../../escape.md',
    'references//guide.md',
    'references\\guide.md',
    'references/./guide.md',
  ])('rejects unsafe path %s', (value) => {
    expect(normalizeSkillPackagePath(value)).toBeNull();
  });

  it('deduplicates package input by path using the last value', () => {
    expect(parseSkillPackageFiles([
      { path: 'references/guide.md', content: 'old' },
      { path: 'references/guide.md', content: 'new' },
    ])).toEqual([{ path: 'references/guide.md', content: 'new' }]);
  });

  it('keeps SKILL.md canonical in the skills table', () => {
    expect(() => parseSkillPackageFiles([{ path: 'SKILL.md', content: '# duplicate' }]))
      .toThrow(/content field/);
  });
});
