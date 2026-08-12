import type { ContextSegment, ContextSegmentKind } from './api/dispatchContext';

/**
 * Presentation logic for the dispatch context viewer.
 *
 * Kept out of the component so the part that can silently lie — the mapping from segment offsets
 * to rendered regions — is unit tested. If this drifts, the viewer shows an operator prompt text
 * attributed to the wrong section, which is worse than showing nothing.
 */

/** One renderable piece of the prompt: either a segment's text or the separator between two. */
export interface PromptRegion {
  type: 'segment' | 'gap';
  text: string;
  segment: ContextSegment | null;
  /** Index into the injected-segment ordering, for anchor ids. */
  index: number;
}

/**
 * Split the prompt into an alternating sequence of gaps and segments.
 *
 * Segments that were considered but not injected have zero width and are excluded here; the
 * outline lists them separately so an operator can see what was left out without a zero-height
 * block appearing in the text pane.
 */
export function splitPromptIntoRegions(
  promptText: string,
  segments: ContextSegment[],
): PromptRegion[] {
  const injected = segments
    .filter(segment => segment.injected && segment.end > segment.start)
    .sort((left, right) => left.start - right.start);

  const regions: PromptRegion[] = [];
  let cursor = 0;

  injected.forEach((segment, index) => {
    // Clamp defensively: a truncated or re-encoded payload must not throw off the whole pane.
    const start = Math.max(cursor, Math.min(segment.start, promptText.length));
    const end = Math.max(start, Math.min(segment.end, promptText.length));
    if (start > cursor) {
      regions.push({ type: 'gap', text: promptText.slice(cursor, start), segment: null, index: -1 });
    }
    regions.push({ type: 'segment', text: promptText.slice(start, end), segment, index });
    cursor = end;
  });

  if (cursor < promptText.length) {
    regions.push({ type: 'gap', text: promptText.slice(cursor), segment: null, index: -1 });
  }

  return regions;
}

/**
 * Rough token estimate for the size read-out.
 *
 * Four characters per token is the usual English approximation and is honest enough for "is this
 * prompt getting too big" without shipping a tokenizer to the browser. Always shown with a ~.
 */
export function approximateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function formatChars(chars: number): string {
  return chars.toLocaleString('en-US');
}

export function formatTokens(chars: number): string {
  const tokens = approximateTokens(chars);
  if (tokens < 1000) return `~${tokens} tokens`;
  return `~${(tokens / 1000).toFixed(1)}k tokens`;
}

export function percentOfPrompt(chars: number, totalChars: number): number {
  if (totalChars <= 0) return 0;
  return Math.round((chars / totalChars) * 1000) / 10;
}

/**
 * A stable colour per segment kind.
 *
 * Assigned by kind rather than by position so the same section keeps its colour between runs —
 * which is what makes flipping through a task's runs readable at a glance.
 */
export const SEGMENT_ACCENTS: Record<ContextSegmentKind, { border: string; text: string; dot: string }> = {
  workflow_goal: { border: 'border-l-sky-500', text: 'text-sky-300', dot: 'bg-sky-500' },
  team: { border: 'border-l-violet-500', text: 'text-violet-300', dot: 'bg-violet-500' },
  project_context: { border: 'border-l-cyan-500', text: 'text-cyan-300', dot: 'bg-cyan-500' },
  job_instructions: { border: 'border-l-amber-500', text: 'text-amber-300', dot: 'bg-amber-500' },
  task: { border: 'border-l-emerald-500', text: 'text-emerald-300', dot: 'bg-emerald-500' },
  task_notes: { border: 'border-l-orange-500', text: 'text-orange-300', dot: 'bg-orange-500' },
  summary_request: { border: 'border-l-pink-500', text: 'text-pink-300', dot: 'bg-pink-500' },
  workspace_path: { border: 'border-l-teal-500', text: 'text-teal-300', dot: 'bg-teal-500' },
  callback_contract: { border: 'border-l-rose-500', text: 'text-rose-300', dot: 'bg-rose-500' },
  github_identity: { border: 'border-l-slate-400', text: 'text-slate-300', dot: 'bg-slate-400' },
};

const FALLBACK_ACCENT = { border: 'border-l-slate-600', text: 'text-slate-300', dot: 'bg-slate-600' };

export function segmentAccent(kind: string) {
  return SEGMENT_ACCENTS[kind as ContextSegmentKind] ?? FALLBACK_ACCENT;
}

/** Human sentence for a source chip, e.g. "Team · Delivery Squad · v3". */
export function describeSource(source: ContextSegment['source']): string {
  const parts = [source.label];
  if (source.version != null) parts.push(`v${source.version}`);
  else if (source.id != null) parts.push(`#${source.id}`);
  return parts.join(' · ');
}

export function segmentAnchorId(kind: string, index: number): string {
  return `context-segment-${kind}-${index}`;
}
