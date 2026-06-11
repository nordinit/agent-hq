import { buildDispatchTaskNotesSection, formatDispatchTaskNote } from './notes';

describe('dispatch prompt task notes formatting', () => {
  it('indents multiline note content', () => {
    expect(formatDispatchTaskNote({
      created_at: '2026-06-04 05:22:27',
      author: 'atlas',
      content: 'Summary line\nDetail line',
    })).toBe('- [2026-06-04 05:22:27] atlas\n  Summary line\n  Detail line');
  });

  it('builds first-run context section with included note counts', () => {
    expect(buildDispatchTaskNotesSection({
      firstRun: true,
      cutoff: null,
      totalNotes: 1,
      includedNotes: [{
        created_at: '2026-06-04 05:22:27',
        author: 'atlas',
        content: 'Keep extraction scoped.',
      }],
      truncated: false,
    })).toBe([
      '## Existing Task Notes',
      '[Dispatch note context: first_run=yes | notes_included=1/1 | cutoff=none]',
      '',
      '- [2026-06-04 05:22:27] atlas',
      '  Keep extraction scoped.',
    ].join('\n'));
  });
});
