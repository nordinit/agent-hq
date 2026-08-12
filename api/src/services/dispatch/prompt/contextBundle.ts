/**
 * The dispatch context bundle — what Agent HQ actually handed an agent, and where each piece
 * came from.
 *
 * WHY THIS EXISTS
 * Prompt assembly used to end in `[a, b, c].filter(Boolean).join('\n\n')`. That join is where
 * provenance died: once concatenated, nothing could say where the job instructions stopped and
 * the task block began, which team definition spoke, or which contract template rendered. The
 * runtime boundary already reserved a field for this — `prompt.bundleFingerprint`, a hash of a
 * bundle that had no structure behind it. This module is that structure.
 *
 * OFFSETS, NOT COPIES
 * A segment stores [start, end) into the rendered `promptText` rather than its own copy of the
 * text. Two things follow, and both are the point:
 *   - The viewer cannot drift from what was sent. Every segment is literally a slice of the
 *     bytes the agent received, so "what we show" and "what we sent" cannot disagree.
 *   - Storage does not double. A 40KB prompt stays 40KB plus a small index.
 * Offsets are UTF-16 code-unit indices, i.e. exactly what String.prototype.slice takes.
 *
 * BYTE STABILITY
 * renderContextBundle() reproduces the historical join semantics exactly: a separator is written
 * only when something precedes it, and an empty section contributes nothing at all. That is what
 * lets the assembler be swapped underneath a live dispatch path and proven unchanged — see
 * contextBundle.golden.test.ts, which rebuilds the pre-bundle concatenation by hand and asserts
 * byte equality.
 */

import { runtimeBoundaryDigest } from '../../runtimeBoundaryBuilder';

export const CONTEXT_BUNDLE_VERSION = 1 as const;

/**
 * What kind of context a segment carries. Stable strings: they are persisted, sent to the UI,
 * and used to line segments up when diffing one run against another.
 */
export type ContextSegmentKind =
  | 'workflow_goal'
  | 'team'
  | 'project_context'
  | 'job_instructions'
  | 'task'
  | 'task_notes'
  | 'workspace_path'
  | 'callback_contract'
  | 'run_identifiers';

/**
 * Where a segment came from, in a shape the UI can render without a per-kind branch: a type, a
 * human label, an optional record id to link to, and free-form detail for everything else.
 */
export interface ContextSegmentSource {
  /** Machine-readable origin, e.g. 'team', 'job', 'contract_template'. */
  type: string;
  /** Operator-facing name of the origin, e.g. the team name or template key. */
  label: string;
  /** Primary key of the originating row, when the origin is one we can link to. */
  id?: number | null;
  /** Monotonic version of the source definition, when it has one (teams carry context_version). */
  version?: number | null;
  /** UI path for a deep link, relative to the app root. */
  href?: string | null;
  /** Anything else worth showing: template path, notes cutoff, path mode. */
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * What the assembler left out. Absent context is harder to debug than present context, so a
 * segment that was capped, truncated, or skipped entirely says so rather than looking complete.
 */
export interface ContextOmission {
  /** Operator-facing sentence, e.g. "Team has no goal, charter, or teammates". */
  reason: string;
  includedCount?: number | null;
  totalCount?: number | null;
  /** Characters dropped by a cap, when the assembler can count them. */
  droppedChars?: number | null;
}

export interface ContextSegment {
  kind: ContextSegmentKind;
  /** Operator-facing section name, e.g. 'Task Notes'. */
  label: string;
  /** Start offset into promptText. Equal to `end` when the segment was not injected. */
  start: number;
  /** End offset (exclusive) into promptText. */
  end: number;
  /** end - start. Denormalized so the UI can sort and total without slicing. */
  chars: number;
  /** False when the section rendered empty and contributed nothing to the prompt. */
  injected: boolean;
  source: ContextSegmentSource;
  omission?: ContextOmission | null;
}

export interface ContextBundle {
  version: typeof CONTEXT_BUNDLE_VERSION;
  /** The exact text handed to the runtime. */
  promptText: string;
  /** In prompt order, including segments that were considered and not injected. */
  segments: ContextSegment[];
  totalChars: number;
}

/**
 * A section offered to the renderer. `text` of '' means the section was considered and produced
 * nothing — it still becomes a segment, marked not-injected, because "the team block was empty"
 * is an answer an operator needs and silence is not.
 */
export interface ContextSegmentDraft {
  kind: ContextSegmentKind;
  label: string;
  text: string;
  /**
   * Written before this section when text already precedes it. Defaults to the historical
   * paragraph break; the GitHub identity block passes '' because it carries its own leading
   * newline and was concatenated without one.
   */
  separator?: string;
  source: ContextSegmentSource;
  omission?: ContextOmission | null;
  /** Why an empty section is empty, when the producer knows. */
  notInjectedReason?: string;
}

export interface RenderContextBundleOptions {
  /**
   * Trailing-whitespace trim applied to the finished prompt, matching buildDispatchMessage()'s
   * closing trimEnd(). The last segment's end offset is clamped so slices stay exact.
   */
  trimEnd?: boolean;
}

const DEFAULT_SEPARATOR = '\n\n';

export function renderContextBundle(
  drafts: Array<ContextSegmentDraft | null | undefined>,
  options: RenderContextBundleOptions = {},
): ContextBundle {
  const segments: ContextSegment[] = [];
  let promptText = '';

  for (const draft of drafts) {
    if (!draft) continue;

    if (!draft.text) {
      // Recorded at the current offset so the outline can show it in the right place.
      segments.push({
        kind: draft.kind,
        label: draft.label,
        start: promptText.length,
        end: promptText.length,
        chars: 0,
        injected: false,
        source: draft.source,
        omission: draft.omission
          ?? (draft.notInjectedReason ? { reason: draft.notInjectedReason } : null),
      });
      continue;
    }

    // A separator only ever sits *between* sections, which is what filter(Boolean).join() did.
    if (promptText.length > 0) promptText += draft.separator ?? DEFAULT_SEPARATOR;
    const start = promptText.length;
    promptText += draft.text;
    segments.push({
      kind: draft.kind,
      label: draft.label,
      start,
      end: promptText.length,
      chars: promptText.length - start,
      injected: true,
      source: draft.source,
      omission: draft.omission ?? null,
    });
  }

  if (options.trimEnd) {
    const trimmed = promptText.trimEnd();
    if (trimmed.length !== promptText.length) {
      promptText = trimmed;
      // Only trailing segments can be affected, and only the injected ones carry a real span.
      for (const segment of segments) {
        if (segment.start > promptText.length) segment.start = promptText.length;
        if (segment.end > promptText.length) segment.end = promptText.length;
        segment.chars = segment.end - segment.start;
        if (segment.injected && segment.chars === 0) segment.injected = false;
      }
    }
  }

  return {
    version: CONTEXT_BUNDLE_VERSION,
    promptText,
    segments,
    totalChars: promptText.length,
  };
}

/**
 * Extend a finished bundle with one more section.
 *
 * For callers that render a prompt in two steps — the historical
 * `message = buildDispatchMessage(...)` followed by `message += '\n\n' + contract'`. Appending
 * leaves the existing text untouched as a prefix, so every offset already recorded stays valid
 * and only the new segment needs placing.
 */
export function appendContextSegment(
  bundle: ContextBundle,
  draft: ContextSegmentDraft,
): ContextBundle {
  if (!draft.text) {
    return {
      ...bundle,
      segments: [
        ...bundle.segments,
        {
          kind: draft.kind,
          label: draft.label,
          start: bundle.promptText.length,
          end: bundle.promptText.length,
          chars: 0,
          injected: false,
          source: draft.source,
          omission: draft.omission
            ?? (draft.notInjectedReason ? { reason: draft.notInjectedReason } : null),
        },
      ],
    };
  }

  const separator = bundle.promptText.length > 0 ? draft.separator ?? DEFAULT_SEPARATOR : '';
  const promptText = bundle.promptText + separator + draft.text;
  const start = bundle.promptText.length + separator.length;

  return {
    version: bundle.version,
    promptText,
    segments: [
      ...bundle.segments,
      {
        kind: draft.kind,
        label: draft.label,
        start,
        end: promptText.length,
        chars: promptText.length - start,
        injected: true,
        source: draft.source,
        omission: draft.omission ?? null,
      },
    ],
    totalChars: promptText.length,
  };
}

/**
 * The same digest the runtime boundary records as `prompt.bundleFingerprint`, so a stored bundle
 * can be checked against the boundary of the execution it belongs to. Keep the label and the
 * hashed value in step with runtimeBoundaryBuilder.ts.
 */
export function fingerprintContextPrompt(promptText: string): string {
  return runtimeBoundaryDigest('runtime-prompt-bundle-v1', promptText);
}

/** Slice a segment back out of its bundle. The viewer's whole contract in one line. */
export function segmentText(bundle: Pick<ContextBundle, 'promptText'>, segment: ContextSegment): string {
  return bundle.promptText.slice(segment.start, segment.end);
}
