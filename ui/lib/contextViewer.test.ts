import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approximateTokens,
  describeSource,
  percentOfPrompt,
  splitPromptIntoRegions,
} from './contextViewer.ts';
import type { ContextSegment } from './api/dispatchContext.ts';

function segment(overrides: Partial<ContextSegment> & Pick<ContextSegment, 'kind' | 'start' | 'end'>): ContextSegment {
  return {
    label: overrides.label ?? overrides.kind,
    chars: overrides.end - overrides.start,
    injected: overrides.injected ?? true,
    source: overrides.source ?? { type: 'test', label: 'test' },
    omission: overrides.omission ?? null,
    ...overrides,
  } as ContextSegment;
}

// "AAA\n\nBBBB\n\nCC"
const PROMPT = 'AAA\n\nBBBB\n\nCC';
const SEGMENTS: ContextSegment[] = [
  segment({ kind: 'job_instructions', start: 0, end: 3 }),
  segment({ kind: 'task', start: 5, end: 9 }),
  segment({ kind: 'callback_contract', start: 11, end: 13 }),
];

test('splitPromptIntoRegions covers the prompt exactly once, in order', () => {
  const regions = splitPromptIntoRegions(PROMPT, SEGMENTS);
  assert.equal(regions.map(r => r.text).join(''), PROMPT);
  assert.deepEqual(
    regions.map(r => r.type),
    ['segment', 'gap', 'segment', 'gap', 'segment'],
  );
  assert.deepEqual(
    regions.filter(r => r.type === 'segment').map(r => r.text),
    ['AAA', 'BBBB', 'CC'],
  );
  assert.deepEqual(regions.filter(r => r.type === 'gap').map(r => r.text), ['\n\n', '\n\n']);
});

test('splitPromptIntoRegions keeps a leading gap when the first segment is offset', () => {
  const regions = splitPromptIntoRegions('  AAA', [segment({ kind: 'task', start: 2, end: 5 })]);
  assert.deepEqual(regions.map(r => r.type), ['gap', 'segment']);
  assert.equal(regions[0].text, '  ');
  assert.equal(regions[1].text, 'AAA');
});

test('splitPromptIntoRegions excludes segments that were never injected', () => {
  const regions = splitPromptIntoRegions(PROMPT, [
    ...SEGMENTS,
    segment({ kind: 'team', start: 0, end: 0, injected: false }),
  ]);
  assert.equal(regions.filter(r => r.type === 'segment').length, 3);
  assert.equal(regions.map(r => r.text).join(''), PROMPT);
});

test('splitPromptIntoRegions clamps offsets that run past the text', () => {
  // A truncated payload must degrade to showing less, never throw or duplicate text.
  const regions = splitPromptIntoRegions('AAA', [segment({ kind: 'task', start: 0, end: 99 })]);
  assert.equal(regions.map(r => r.text).join(''), 'AAA');
});

test('splitPromptIntoRegions never emits overlapping segments', () => {
  const regions = splitPromptIntoRegions('ABCDEF', [
    segment({ kind: 'task', start: 0, end: 4 }),
    segment({ kind: 'team', start: 2, end: 6 }),
  ]);
  assert.equal(regions.map(r => r.text).join(''), 'ABCDEF');
});

test('splitPromptIntoRegions handles an empty prompt', () => {
  assert.deepEqual(splitPromptIntoRegions('', []), []);
});

test('approximateTokens and percentOfPrompt report honest sizes', () => {
  assert.equal(approximateTokens(0), 0);
  assert.equal(approximateTokens(4), 1);
  assert.equal(approximateTokens(5), 2);
  assert.equal(percentOfPrompt(50, 200), 25);
  assert.equal(percentOfPrompt(1, 0), 0);
});

test('describeSource appends a version when the source carries one', () => {
  assert.equal(describeSource({ type: 'team', label: 'Delivery Squad', id: 7, version: 3 }), 'Delivery Squad · v3');
  assert.equal(describeSource({ type: 'job', label: 'Backend Engineer', id: 42 }), 'Backend Engineer · #42');
  assert.equal(describeSource({ type: 'task_notes', label: 'Notes' }), 'Notes');
});
