/**
 * Renderer mechanics: how drafts become one string plus an index into it.
 *
 * These rules are load-bearing for the whole feature. If a separator lands in the wrong place the
 * bytes every agent receives change; if an offset lands in the wrong place the viewer attributes
 * one section's text to another. Both are silent failures, so they are pinned here.
 */

import {
  appendContextSegment,
  fingerprintContextPrompt,
  renderContextBundle,
  segmentText,
  type ContextSegmentDraft,
} from './contextBundle';

function draft(
  kind: ContextSegmentDraft['kind'],
  text: string,
  overrides: Partial<ContextSegmentDraft> = {},
): ContextSegmentDraft {
  return { kind, label: kind, text, source: { type: kind, label: kind }, ...overrides };
}

describe('renderContextBundle joins sections', () => {
  it('writes a separator only between sections, never before the first', () => {
    const bundle = renderContextBundle([
      draft('job_instructions', 'A'),
      draft('task', 'B'),
      draft('callback_contract', 'C'),
    ]);
    expect(bundle.promptText).toBe('A\n\nB\n\nC');
  });

  it('skips an empty section entirely rather than leaving a gap', () => {
    const bundle = renderContextBundle([
      draft('team', ''),
      draft('job_instructions', 'A'),
      draft('task_notes', ''),
      draft('task', 'B'),
    ]);
    expect(bundle.promptText).toBe('A\n\nB');
  });

  it('keeps an empty section in the index, positioned and explained', () => {
    const bundle = renderContextBundle([
      draft('job_instructions', 'A'),
      draft('task_notes', '', { notInjectedReason: 'This task has no notes yet' }),
      draft('task', 'B'),
    ]);

    expect(bundle.segments.map(s => s.kind)).toEqual(['job_instructions', 'task_notes', 'task']);
    const notes = bundle.segments[1];
    expect(notes.injected).toBe(false);
    expect(notes.chars).toBe(0);
    expect(notes.start).toBe(notes.end);
    expect(notes.omission?.reason).toBe('This task has no notes yet');
  });

  it('honours a per-section separator override', () => {
    // The GitHub identity block carries its own leading newline and was concatenated with none.
    const bundle = renderContextBundle([
      draft('callback_contract', 'CONTRACT'),
      draft('github_identity', '\n## GitHub Identity\n', { separator: '' }),
    ]);
    expect(bundle.promptText).toBe('CONTRACT\n## GitHub Identity\n');
  });

  it('makes every injected segment an exact slice of the prompt', () => {
    const bundle = renderContextBundle([
      draft('team', 'TEAM'),
      draft('job_instructions', 'multi\nline\ninstructions'),
      draft('task', 'TASK'),
    ]);

    expect(segmentText(bundle, bundle.segments[0])).toBe('TEAM');
    expect(segmentText(bundle, bundle.segments[1])).toBe('multi\nline\ninstructions');
    expect(segmentText(bundle, bundle.segments[2])).toBe('TASK');
    expect(bundle.totalChars).toBe(bundle.promptText.length);
  });

  it('never overlaps or reorders spans', () => {
    const bundle = renderContextBundle([
      draft('team', 'TEAM'), draft('job_instructions', 'JOB'), draft('task', 'TASK'),
    ]);
    const injected = bundle.segments.filter(s => s.injected);
    for (let i = 1; i < injected.length; i += 1) {
      expect(injected[i].start).toBeGreaterThanOrEqual(injected[i - 1].end);
    }
  });

  it('clamps offsets when trimEnd removes trailing whitespace', () => {
    const bundle = renderContextBundle(
      [draft('job_instructions', 'A'), draft('summary_request', 'B\n\n')],
      { trimEnd: true },
    );
    expect(bundle.promptText).toBe('A\n\nB');
    for (const segment of bundle.segments) {
      expect(segment.end).toBeLessThanOrEqual(bundle.promptText.length);
      expect(segment.chars).toBe(segment.end - segment.start);
    }
    expect(segmentText(bundle, bundle.segments[1])).toBe('B');
  });

  it('marks a section not-injected when trimEnd consumes all of it', () => {
    const bundle = renderContextBundle(
      [draft('job_instructions', 'A'), draft('summary_request', '\n\n')],
      { trimEnd: true },
    );
    expect(bundle.promptText).toBe('A');
    expect(bundle.segments[1].injected).toBe(false);
  });
});

describe('appendContextSegment extends a finished bundle', () => {
  const base = renderContextBundle([draft('job_instructions', 'A'), draft('task', 'B')]);

  it('appends with the standard separator and leaves prefix offsets valid', () => {
    const extended = appendContextSegment(base, draft('callback_contract', 'CONTRACT'));
    expect(extended.promptText).toBe('A\n\nB\n\nCONTRACT');
    expect(segmentText(extended, extended.segments[0])).toBe('A');
    expect(segmentText(extended, extended.segments[1])).toBe('B');
    expect(segmentText(extended, extended.segments[2])).toBe('CONTRACT');
  });

  it('omits the separator when there is no prefix to separate from', () => {
    const extended = appendContextSegment(renderContextBundle([]), draft('callback_contract', 'CONTRACT'));
    expect(extended.promptText).toBe('CONTRACT');
  });

  it('records an empty append as a not-injected segment', () => {
    const extended = appendContextSegment(base, draft('github_identity', '', {
      notInjectedReason: 'No GitHub identity is assigned to this agent',
    }));
    expect(extended.promptText).toBe(base.promptText);
    expect(extended.segments[2].injected).toBe(false);
    expect(extended.segments[2].omission?.reason).toMatch(/No GitHub identity/);
  });
});

describe('prompt fingerprint', () => {
  it('is stable for identical text and differs for any change', () => {
    expect(fingerprintContextPrompt('hello')).toBe(fingerprintContextPrompt('hello'));
    expect(fingerprintContextPrompt('hello')).not.toBe(fingerprintContextPrompt('hello '));
    expect(fingerprintContextPrompt('hello')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
