/**
 * Segment-level diff between two dispatch context bundles.
 *
 * The question this answers is the one that costs the most time to answer by hand: a task ran,
 * failed, was retried, and behaved differently — what changed in what the agent was told? Notes
 * are the only unbounded input to a dispatch, so the usual answer is "notes grew and pushed
 * something past a cap", which is visible here in one line and nowhere else.
 *
 * Segments are matched by kind and by occurrence within that kind, not by offset: offsets shift
 * whenever anything upstream changes size, so matching on them would report every section as
 * changed the moment the first one did.
 */

import type { ContextSegment } from '../../services/dispatch/prompt/contextBundle';

export type ContextSegmentChange = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ContextDiffLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

export interface ContextSegmentDiff {
  kind: string;
  label: string;
  change: ContextSegmentChange;
  previousChars: number;
  currentChars: number;
  charDelta: number;
  addedLines: number;
  removedLines: number;
  /** Null when both sides are identical, or when the section was too large to diff line by line. */
  hunks: ContextDiffLine[] | null;
  /** Set when the line diff was skipped for size; the char and line counts remain exact. */
  hunksTruncated: boolean;
  /** Source provenance of the newer side, falling back to the older when the segment was removed. */
  source: ContextSegment['source'];
  previousSource: ContextSegment['source'] | null;
  /** True when the same section came from a different record or version between runs. */
  sourceChanged: boolean;
}

export interface ContextBundleDiff {
  previousInstanceId: number;
  previousCreatedAt: string | null;
  segments: ContextSegmentDiff[];
  totals: {
    previousChars: number;
    currentChars: number;
    charDelta: number;
    changedSegments: number;
  };
}

/** Beyond this the quadratic line diff stops earning its cost; counts are still reported. */
const MAX_DIFF_LINES = 1_500;
/** Keeps a pathological section from producing a megabyte of diff payload. */
const MAX_HUNK_LINES = 400;

interface BundleSide {
  instanceId: number;
  createdAt: string | null;
  promptText: string;
  segments: ContextSegment[];
}

function segmentKey(segment: ContextSegment, seen: Map<string, number>): string {
  const index = seen.get(segment.kind) ?? 0;
  seen.set(segment.kind, index + 1);
  return `${segment.kind}#${index}`;
}

function indexSegments(side: BundleSide): Map<string, { segment: ContextSegment; text: string }> {
  const seen = new Map<string, number>();
  const index = new Map<string, { segment: ContextSegment; text: string }>();
  for (const segment of side.segments) {
    index.set(segmentKey(segment, seen), {
      segment,
      text: segment.injected ? side.promptText.slice(segment.start, segment.end) : '',
    });
  }
  return index;
}

function sourceIdentity(source: ContextSegment['source'] | null | undefined): string {
  if (!source) return '';
  return `${source.type}:${source.id ?? ''}:${source.version ?? ''}:${source.label ?? ''}`;
}

/** Longest common subsequence over lines, the standard dynamic-programming table. */
function diffLines(previous: string[], current: string[]): ContextDiffLine[] {
  const rows = previous.length;
  const cols = current.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = previous[i] === current[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: ContextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (previous[i] === current[j]) {
      lines.push({ type: 'context', text: previous[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: 'remove', text: previous[i] });
      i += 1;
    } else {
      lines.push({ type: 'add', text: current[j] });
      j += 1;
    }
  }
  while (i < rows) lines.push({ type: 'remove', text: previous[i++] });
  while (j < cols) lines.push({ type: 'add', text: current[j++] });
  return lines;
}

/**
 * Trim the shared head and tail before diffing.
 *
 * Two runs of the same task usually share almost everything — the job instructions, the contract,
 * the workspace block — so this collapses most sections to a handful of differing lines and keeps
 * the quadratic step off the full text.
 */
function diffSection(previousText: string, currentText: string): {
  hunks: ContextDiffLine[] | null;
  truncated: boolean;
  addedLines: number;
  removedLines: number;
} {
  if (previousText === currentText) {
    return { hunks: null, truncated: false, addedLines: 0, removedLines: 0 };
  }

  const previousLines = previousText.length ? previousText.split('\n') : [];
  const currentLines = currentText.length ? currentText.split('\n') : [];

  let head = 0;
  while (head < previousLines.length && head < currentLines.length && previousLines[head] === currentLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < previousLines.length - head
    && tail < currentLines.length - head
    && previousLines[previousLines.length - 1 - tail] === currentLines[currentLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const previousMiddle = previousLines.slice(head, previousLines.length - tail);
  const currentMiddle = currentLines.slice(head, currentLines.length - tail);

  if (previousMiddle.length > MAX_DIFF_LINES || currentMiddle.length > MAX_DIFF_LINES) {
    return {
      hunks: null,
      truncated: true,
      // Without an alignment the honest counts are whole-block replace numbers.
      addedLines: currentMiddle.length,
      removedLines: previousMiddle.length,
    };
  }

  const middle = diffLines(previousMiddle, currentMiddle);
  const addedLines = middle.filter(line => line.type === 'add').length;
  const removedLines = middle.filter(line => line.type === 'remove').length;

  return {
    hunks: middle.slice(0, MAX_HUNK_LINES),
    truncated: middle.length > MAX_HUNK_LINES,
    addedLines,
    removedLines,
  };
}

export function diffContextBundles(previous: BundleSide, current: BundleSide): ContextBundleDiff {
  const previousIndex = indexSegments(previous);
  const currentIndex = indexSegments(current);
  const keys = [...currentIndex.keys()];
  for (const key of previousIndex.keys()) if (!currentIndex.has(key)) keys.push(key);

  const segments: ContextSegmentDiff[] = keys.map((key) => {
    const before = previousIndex.get(key);
    const after = currentIndex.get(key);
    const previousText = before?.text ?? '';
    const currentText = after?.text ?? '';
    const segment = (after ?? before)!.segment;

    const change: ContextSegmentChange = !before || (!before.segment.injected && after?.segment.injected)
      ? 'added'
      : !after || (!after.segment.injected && before.segment.injected)
        ? 'removed'
        : previousText === currentText
          ? 'unchanged'
          : 'changed';

    const { hunks, truncated, addedLines, removedLines } = diffSection(previousText, currentText);

    return {
      kind: segment.kind,
      label: segment.label,
      change,
      previousChars: previousText.length,
      currentChars: currentText.length,
      charDelta: currentText.length - previousText.length,
      addedLines,
      removedLines,
      hunks,
      hunksTruncated: truncated,
      source: segment.source,
      previousSource: before?.segment.source ?? null,
      sourceChanged: Boolean(before && after)
        && sourceIdentity(before?.segment.source) !== sourceIdentity(after?.segment.source),
    };
  });

  return {
    previousInstanceId: previous.instanceId,
    previousCreatedAt: previous.createdAt,
    segments,
    totals: {
      previousChars: previous.promptText.length,
      currentChars: current.promptText.length,
      charDelta: current.promptText.length - previous.promptText.length,
      changedSegments: segments.filter(s => s.change !== 'unchanged').length,
    },
  };
}
