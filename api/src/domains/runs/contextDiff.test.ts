import { diffContextBundles } from './contextDiff';
import type { ContextSegment } from '../../services/dispatch/prompt/contextBundle';

/** Build a bundle side from labelled sections joined the way the assembler joins them. */
function side(instanceId: number, sections: Array<[ContextSegment['kind'], string]>) {
  let promptText = '';
  const segments: ContextSegment[] = [];
  for (const [kind, text] of sections) {
    if (!text) {
      segments.push({
        kind, label: kind, start: promptText.length, end: promptText.length,
        chars: 0, injected: false, source: { type: kind, label: kind }, omission: null,
      });
      continue;
    }
    if (promptText.length) promptText += '\n\n';
    const start = promptText.length;
    promptText += text;
    segments.push({
      kind, label: kind, start, end: promptText.length,
      chars: promptText.length - start, injected: true,
      source: { type: kind, label: kind }, omission: null,
    });
  }
  return { instanceId, createdAt: '2026-08-09 10:00:00', promptText, segments };
}

describe('context bundle diff', () => {
  it('matches segments by kind, not by offset', () => {
    // The team block grows, shifting every later offset. Nothing downstream actually changed.
    const previous = side(1, [
      ['team', 'Team: Squad'],
      ['job_instructions', 'Do the work.'],
      ['task', '## Assigned Task\nTask #1'],
    ]);
    const current = side(2, [
      ['team', 'Team: Squad\nGoal: Ship it.\nYou are Nova.'],
      ['job_instructions', 'Do the work.'],
      ['task', '## Assigned Task\nTask #1'],
    ]);

    const diff = diffContextBundles(previous, current);
    expect(diff.segments.find(s => s.kind === 'team')?.change).toBe('changed');
    expect(diff.segments.find(s => s.kind === 'job_instructions')?.change).toBe('unchanged');
    expect(diff.segments.find(s => s.kind === 'task')?.change).toBe('unchanged');
    expect(diff.totals.changedSegments).toBe(1);
  });

  it('reports a section that appeared as added and one that vanished as removed', () => {
    const previous = side(1, [['job_instructions', 'Do the work.'], ['task_notes', 'Old note.']]);
    const current = side(2, [['job_instructions', 'Do the work.'], ['task_notes', '']]);

    const diff = diffContextBundles(previous, current);
    const notes = diff.segments.find(s => s.kind === 'task_notes')!;
    expect(notes.change).toBe('removed');
    expect(notes.charDelta).toBe(-'Old note.'.length);

    const reversed = diffContextBundles(current, previous);
    expect(reversed.segments.find(s => s.kind === 'task_notes')?.change).toBe('added');
  });

  it('produces line hunks for a changed section', () => {
    const previous = side(1, [['task_notes', 'line one\nline two\nline three']]);
    const current = side(2, [['task_notes', 'line one\nline two CHANGED\nline three\nline four']]);

    const notes = diffContextBundles(previous, current).segments[0];
    expect(notes.change).toBe('changed');
    expect(notes.addedLines).toBe(2);
    expect(notes.removedLines).toBe(1);
    expect(notes.hunks?.some(h => h.type === 'add' && h.text === 'line four')).toBe(true);
    expect(notes.hunks?.some(h => h.type === 'remove' && h.text === 'line two')).toBe(true);
    // The shared head and tail are trimmed before diffing, so they never reach the payload.
    expect(notes.hunks?.some(h => h.text === 'line one')).toBe(false);
  });

  it('flags a section whose source record changed even when the text is identical', () => {
    const previous = side(1, [['team', 'Team block']]);
    const current = side(2, [['team', 'Team block']]);
    previous.segments[0].source = { type: 'team', label: 'Squad', id: 7, version: 2 };
    current.segments[0].source = { type: 'team', label: 'Squad', id: 7, version: 3 };

    const team = diffContextBundles(previous, current).segments[0];
    expect(team.change).toBe('unchanged');
    expect(team.sourceChanged).toBe(true);
    expect(team.previousSource?.version).toBe(2);
  });

  it('skips the line diff for an oversized section but keeps the counts honest', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `note ${i}`).join('\n');
    const bigger = Array.from({ length: 4200 }, (_, i) => `entry ${i}`).join('\n');
    const diff = diffContextBundles(side(1, [['task_notes', big]]), side(2, [['task_notes', bigger]]));

    const notes = diff.segments[0];
    expect(notes.change).toBe('changed');
    expect(notes.hunks).toBeNull();
    expect(notes.hunksTruncated).toBe(true);
    expect(notes.charDelta).toBe(bigger.length - big.length);
  });

  it('totals the whole-prompt delta', () => {
    const diff = diffContextBundles(
      side(1, [['job_instructions', 'short']]),
      side(2, [['job_instructions', 'much longer instructions']]),
    );
    expect(diff.totals.previousChars).toBe('short'.length);
    expect(diff.totals.currentChars).toBe('much longer instructions'.length);
    expect(diff.totals.charDelta).toBe('much longer instructions'.length - 'short'.length);
    expect(diff.previousInstanceId).toBe(1);
  });
});
