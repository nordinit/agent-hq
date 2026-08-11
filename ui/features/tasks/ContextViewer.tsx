'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, Check, Copy, Download, FileText, GitCompare, Layers, Loader2, X,
} from 'lucide-react';
import {
  api,
  type ContextSegment,
  type ContextSegmentDiff,
  type InstanceContextView,
  type RuntimeContextView,
} from '@/lib/api';
import { formatDateTime } from '@/lib/date';
import {
  describeSource,
  formatChars,
  formatTokens,
  percentOfPrompt,
  segmentAccent,
  segmentAnchorId,
  splitPromptIntoRegions,
} from '@/lib/contextViewer';

type ViewerTab = 'prompt' | 'runtime' | 'diff';

// ── Shared bits ──────────────────────────────────────────────────────────────

function SourceChip({ source }: { source: ContextSegment['source'] }) {
  const label = describeSource(source);
  const body = (
    <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800/70 px-1.5 py-0.5 text-[10px] text-slate-300">
      <span className="text-slate-500 uppercase tracking-wide">{source.type.replace(/_/g, ' ')}</span>
      <span className="truncate max-w-[16rem]">{label}</span>
    </span>
  );
  if (!source.href) return body;
  return (
    <Link href={source.href} onClick={e => e.stopPropagation()} className="hover:opacity-80" title={`Open ${label}`}>
      {body}
    </Link>
  );
}

function DetailGrid({ detail }: { detail?: Record<string, string | number | boolean | null> }) {
  const entries = Object.entries(detail ?? {}).filter(([, value]) => value !== null && value !== '');
  if (entries.length === 0) return null;
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-1.5 text-[11px] min-w-0">
          <dt className="text-slate-500 shrink-0">{key.replace(/_/g, ' ')}:</dt>
          <dd className="text-slate-300 font-mono truncate" title={String(value)}>{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Outline ──────────────────────────────────────────────────────────────────

function SegmentOutline({
  segments,
  totalChars,
  activeKey,
  onSelect,
}: {
  segments: ContextSegment[];
  totalChars: number;
  activeKey: string | null;
  onSelect: (segment: ContextSegment, index: number) => void;
}) {
  let injectedIndex = -1;
  return (
    <ul className="space-y-1">
      {segments.map((segment, position) => {
        if (segment.injected) injectedIndex += 1;
        const index = injectedIndex;
        const accent = segmentAccent(segment.kind);
        const key = `${segment.kind}-${position}`;
        const isActive = activeKey === key;

        return (
          <li key={key}>
            <button
              type="button"
              disabled={!segment.injected}
              onClick={() => onSelect(segment, index)}
              className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                segment.injected
                  ? isActive
                    ? 'border-amber-500/50 bg-slate-800'
                    : 'border-slate-800 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800/70'
                  : 'border-dashed border-slate-800 bg-transparent cursor-default'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${segment.injected ? accent.dot : 'bg-slate-700'}`} />
                <span className={`text-xs font-medium truncate ${segment.injected ? 'text-slate-200' : 'text-slate-500'}`}>
                  {segment.label}
                </span>
                {segment.injected && (
                  <span className="ml-auto shrink-0 text-[10px] text-slate-500">
                    {percentOfPrompt(segment.chars, totalChars)}%
                  </span>
                )}
              </div>

              <div className="mt-1 pl-4">
                {segment.injected ? (
                  <p className="text-[10px] text-slate-500">{formatChars(segment.chars)} chars</p>
                ) : (
                  <p className="text-[10px] italic text-slate-600">Not injected</p>
                )}
                <div className="mt-1"><SourceChip source={segment.source} /></div>
                {segment.omission && (
                  <p className={`mt-1 flex items-start gap-1 text-[10px] ${segment.injected ? 'text-amber-400/90' : 'text-slate-600'}`}>
                    {segment.injected && <AlertTriangle className="mt-px h-2.5 w-2.5 shrink-0" />}
                    <span>{segment.omission.reason}</span>
                  </p>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── Prompt pane ──────────────────────────────────────────────────────────────

function PromptPane({
  promptText,
  segments,
  activeKey,
  onActivate,
}: {
  promptText: string;
  segments: ContextSegment[];
  activeKey: string | null;
  onActivate: (key: string) => void;
}) {
  const regions = useMemo(() => splitPromptIntoRegions(promptText, segments), [promptText, segments]);
  const positionByStart = useMemo(() => {
    const map = new Map<number, number>();
    segments.forEach((segment, position) => {
      if (segment.injected) map.set(segment.start, position);
    });
    return map;
  }, [segments]);

  return (
    <div className="space-y-2">
      {regions.map((region, i) => {
        if (region.type === 'gap' || !region.segment) {
          // The separator bytes are part of the prompt; showing them as a thin rule keeps the
          // pane honest about spacing without spending vertical space on blank lines.
          return <div key={`gap-${i}`} className="h-px bg-slate-800/60" aria-hidden />;
        }

        const segment = region.segment;
        const position = positionByStart.get(segment.start) ?? i;
        const key = `${segment.kind}-${position}`;
        const accent = segmentAccent(segment.kind);
        const isActive = activeKey === key;

        return (
          <section
            key={key}
            id={segmentAnchorId(segment.kind, region.index)}
            onClick={() => onActivate(key)}
            className={`scroll-mt-4 rounded-r-lg border-l-2 bg-slate-900/60 transition-colors ${accent.border} ${
              isActive ? 'ring-1 ring-amber-500/40 bg-slate-900' : 'hover:bg-slate-900'
            }`}
          >
            <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5">
              <span className={`text-[11px] font-semibold uppercase tracking-wide ${accent.text}`}>{segment.label}</span>
              <span className="text-[10px] text-slate-500">
                {formatChars(segment.chars)} chars · {formatTokens(segment.chars)}
              </span>
              <span className="ml-auto"><SourceChip source={segment.source} /></span>
            </header>

            {segment.omission && (
              <p className="flex items-start gap-1.5 border-b border-amber-500/20 bg-amber-950/20 px-3 py-1.5 text-[11px] text-amber-200">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                <span>{segment.omission.reason}</span>
              </p>
            )}

            <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-300">
              {region.text}
            </pre>

            {segment.source.detail && (
              <div className="border-t border-slate-800 px-3 pb-2">
                <DetailGrid detail={segment.source.detail} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ── Runtime pane (phase 4) ───────────────────────────────────────────────────

function RuntimeRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex gap-2 py-1 text-xs border-b border-slate-800/60 last:border-0">
      <span className="w-44 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 break-words text-slate-200">{value}</span>
    </div>
  );
}

function NameList({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="italic text-slate-600">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {names.map(name => (
        <span key={name} className="rounded border border-slate-700 bg-slate-800/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
          {name}
        </span>
      ))}
    </span>
  );
}

function RuntimePane({ runtime }: { runtime: RuntimeContextView | null }) {
  if (!runtime) {
    return (
      <p className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-xs italic text-slate-500">
        No runtime execution record for this run. Runs dispatched before durable runtime state
        landed, or that failed before launch, have no boundary to show.
      </p>
    );
  }

  const boundary = runtime.boundary ?? {};
  const tools = boundary.tools ?? {};
  const mcpServers = tools.mcpServers ?? [];
  const skills = tools.skills ?? [];
  const registryTools = tools.registryTools ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Model policy</h4>
        <RuntimeRow label="Runtime" value={boundary.runtime?.type ?? runtime.driver_type} />
        <RuntimeRow label="Model" value={boundary.runtime?.model ?? <span className="italic text-slate-500">runtime default</span>} />
        <RuntimeRow label="Reasoning" value={boundary.runtime?.reasoning} />
        <RuntimeRow label="Fast mode" value={boundary.runtime?.fastMode == null ? null : boundary.runtime.fastMode ? 'on' : 'off'} />
        <RuntimeRow label="Timeout" value={boundary.runtime?.timeoutSeconds ? `${boundary.runtime.timeoutSeconds}s` : null} />
        <RuntimeRow label="Token budget" value={boundary.runtime?.tokenBudget} />
        <RuntimeRow label="Turn limit" value={boundary.runtime?.turnLimit} />
        <RuntimeRow label="Provider" value={boundary.auth?.provider} />
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Workspace</h4>
        <RuntimeRow label="Active repo root" value={<span className="font-mono">{boundary.workspace?.activeRepoRoot}</span>} />
        <RuntimeRow label="Workspace root" value={<span className="font-mono">{boundary.workspace?.workspaceRoot}</span>} />
        <RuntimeRow label="Repo access mode" value={boundary.workspace?.repoAccessMode} />
        <RuntimeRow label="Repo source" value={<span className="font-mono">{boundary.workspace?.repoSource}</span>} />
        <RuntimeRow label="Branch" value={<span className="font-mono">{boundary.workspace?.branch}</span>} />
        <RuntimeRow label="Execution target" value={runtime.execution_target_id} />
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Tools delivered by Agent HQ
        </h4>
        <RuntimeRow label={`Skills (${skills.length})`} value={<NameList names={skills.map(s => String(s.name))} />} />
        <RuntimeRow label={`MCP servers (${mcpServers.length})`} value={<NameList names={mcpServers.map(s => String(s.name))} />} />
        <RuntimeRow label={`Registry tools (${registryTools.length})`} value={<NameList names={registryTools.map(t => String(t.name))} />} />
        <RuntimeRow label="Required lifecycle tools" value={<NameList names={tools.requiredLifecycleTools ?? []} />} />
        <RuntimeRow label="Built-in tools" value={<NameList names={tools.builtIn ?? []} />} />
      </section>

      {mcpServers.length > 0 && (
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">MCP server detail</h4>
          <div className="space-y-2">
            {mcpServers.map(server => (
              <div key={String(server.name)} className="rounded border border-slate-800 bg-slate-950/40 p-2">
                <p className="font-mono text-xs text-slate-200">{String(server.name)}</p>
                {Array.isArray(server.requiredToolNames) && server.requiredToolNames.length > 0 && (
                  <div className="mt-1"><NameList names={server.requiredToolNames.map(String)} /></div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-[10px] italic text-slate-600">
        Boundary fingerprint: <span className="font-mono">{runtime.checkpoint_fingerprint ?? 'none'}</span>
      </p>
    </div>
  );
}

// ── Diff pane (phase 5) ──────────────────────────────────────────────────────

const CHANGE_BADGE: Record<ContextSegmentDiff['change'], string> = {
  added: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  removed: 'bg-red-500/15 text-red-300 border-red-500/30',
  changed: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  unchanged: 'bg-slate-700/40 text-slate-400 border-slate-700',
};

function formatDelta(delta: number): string {
  if (delta === 0) return '±0';
  return `${delta > 0 ? '+' : '−'}${formatChars(Math.abs(delta))}`;
}

function DiffPane({ view }: { view: InstanceContextView }) {
  const diff = view.diff;
  if (!diff) {
    return (
      <p className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-xs italic text-slate-500">
        This is the earliest captured run for the task, so there is nothing to compare it against.
      </p>
    );
  }

  const changed = diff.segments.filter(s => s.change !== 'unchanged');
  const unchanged = diff.segments.filter(s => s.change === 'unchanged');

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs">
        <p className="text-slate-300">
          Compared against run <span className="font-mono text-slate-100">#{diff.previousInstanceId}</span>
          {diff.previousCreatedAt ? <span className="text-slate-500"> · {formatDateTime(diff.previousCreatedAt)}</span> : null}
        </p>
        <p className="mt-1 text-slate-400">
          {formatChars(diff.totals.previousChars)} → {formatChars(diff.totals.currentChars)} chars
          {' '}(<span className={diff.totals.charDelta > 0 ? 'text-emerald-300' : diff.totals.charDelta < 0 ? 'text-red-300' : 'text-slate-400'}>
            {formatDelta(diff.totals.charDelta)}
          </span>)
          {' · '}
          {diff.totals.changedSegments === 0
            ? 'no sections changed'
            : `${diff.totals.changedSegments} section${diff.totals.changedSegments === 1 ? '' : 's'} changed`}
        </p>
      </div>

      {changed.map(segment => (
        <section key={`${segment.kind}-${segment.label}`} className="rounded-lg border border-slate-800 bg-slate-900/60">
          <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${CHANGE_BADGE[segment.change]}`}>
              {segment.change}
            </span>
            <span className="text-xs font-medium text-slate-200">{segment.label}</span>
            <span className="text-[10px] text-slate-500">
              {formatChars(segment.previousChars)} → {formatChars(segment.currentChars)} chars
              {' '}({formatDelta(segment.charDelta)})
            </span>
            {(segment.addedLines > 0 || segment.removedLines > 0) && (
              <span className="text-[10px]">
                <span className="text-emerald-400">+{segment.addedLines}</span>
                {' '}
                <span className="text-red-400">−{segment.removedLines}</span>
              </span>
            )}
            {segment.sourceChanged && (
              <span className="rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-200">
                source changed
              </span>
            )}
            <span className="ml-auto"><SourceChip source={segment.source} /></span>
          </header>

          {segment.sourceChanged && segment.previousSource && (
            <p className="border-b border-slate-800 px-3 py-1.5 text-[11px] text-slate-400">
              was <span className="text-slate-200">{describeSource(segment.previousSource)}</span>
            </p>
          )}

          {segment.hunks && segment.hunks.length > 0 ? (
            <div className="overflow-x-auto">
              <pre className="min-w-full font-mono text-[11px] leading-relaxed">
                {segment.hunks.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.type === 'add'
                        ? 'bg-emerald-500/10 text-emerald-200'
                        : line.type === 'remove'
                          ? 'bg-red-500/10 text-red-200'
                          : 'text-slate-500'
                    }
                  >
                    <span className="select-none px-2 text-slate-600">
                      {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
                    </span>
                    {line.text || ' '}
                  </div>
                ))}
              </pre>
            </div>
          ) : (
            <p className="px-3 py-2 text-[11px] italic text-slate-500">
              {segment.hunksTruncated
                ? 'Section too large to diff line by line; character and line counts above are exact.'
                : 'No line-level changes.'}
            </p>
          )}

          {segment.hunksTruncated && segment.hunks && segment.hunks.length > 0 && (
            <p className="border-t border-slate-800 px-3 py-1.5 text-[10px] italic text-amber-300/80">
              Diff truncated for display; counts above cover the whole section.
            </p>
          )}
        </section>
      ))}

      {unchanged.length > 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
          <p className="text-[11px] text-slate-500">
            Unchanged: {unchanged.map(s => s.label).join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Viewer shell ─────────────────────────────────────────────────────────────

export function ContextViewer({
  instanceId,
  onClose,
}: {
  instanceId: number;
  onClose: () => void;
}) {
  const [currentInstanceId, setCurrentInstanceId] = useState(instanceId);
  const [view, setView] = useState<InstanceContextView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ViewerTab>('prompt');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const promptPaneRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setCurrentInstanceId(instanceId); }, [instanceId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getInstanceContext(currentInstanceId)
      .then((data) => { if (!cancelled) setView(data); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentInstanceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    if (!view?.prompt) return;
    try {
      await navigator.clipboard.writeText(view.prompt.promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }, [view]);

  const handleDownload = useCallback(() => {
    if (!view) return;
    const blob = new Blob([JSON.stringify(view, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `context-run-${view.instanceId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [view]);

  const prompt = view?.prompt ?? null;
  /**
   * Two indices are in play and they are not the same number: highlight keys are position in the
   * full segment list (so uninjected sections still get a stable key), while anchor ids use the
   * injected ordinal (so they match the ids the prompt pane renders).
   */
  const outlineSelect = useCallback((segment: ContextSegment, injectedIndex: number) => {
    if (!segment.injected) return;
    const position = prompt?.segments.indexOf(segment) ?? -1;
    if (position >= 0) setActiveKey(`${segment.kind}-${position}`);
    document
      .getElementById(segmentAnchorId(segment.kind, injectedIndex))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [prompt]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-950/95 backdrop-blur-sm">
      {/* Header */}
      <header className="shrink-0 border-b border-slate-800 bg-slate-900/80 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Layers className="h-4 w-4 text-amber-400" />
              Context delivered to {view?.run.agentName ?? 'agent'}
              <span className="font-mono text-xs text-slate-400">run #{currentInstanceId}</span>
            </h2>
            {view && (
              <p className="mt-0.5 truncate text-xs text-slate-400">
                {view.run.taskId ? `Task #${view.run.taskId}: ${view.run.taskTitle ?? ''}` : 'Non-task dispatch'}
                {view.run.dispatchedAt ? ` · ${formatDateTime(view.run.dispatchedAt)}` : ''}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {view && view.runs.length > 1 && (
              <select
                value={currentInstanceId}
                onChange={e => setCurrentInstanceId(Number(e.target.value))}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:border-amber-400 focus:outline-none"
                title="Switch run"
              >
                {view.runs.map((run, i) => (
                  <option key={run.instanceId} value={run.instanceId}>
                    #{run.instanceId}{i === 0 ? ' (latest)' : ''} · {formatChars(run.promptChars)} chars
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={handleCopy}
              disabled={!prompt}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 transition-colors hover:border-amber-500/40 hover:text-amber-300 disabled:opacity-40"
              title="Copy the raw prompt"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={!view}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 transition-colors hover:border-amber-500/40 hover:text-amber-300 disabled:opacity-40"
              title="Download the bundle as JSON"
            >
              <Download className="h-3 w-3" />
              JSON
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Size read-out + tabs */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {(['prompt', 'runtime', 'diff'] as ViewerTab[]).map(id => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === id ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {id === 'prompt' && <FileText className="h-3 w-3" />}
              {id === 'runtime' && <Layers className="h-3 w-3" />}
              {id === 'diff' && <GitCompare className="h-3 w-3" />}
              {id === 'prompt' ? 'Prompt' : id === 'runtime' ? 'Runtime context' : 'Diff vs previous'}
              {id === 'diff' && view?.diff && view.diff.totals.changedSegments > 0 && (
                <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-200">
                  {view.diff.totals.changedSegments}
                </span>
              )}
            </button>
          ))}

          {prompt && (
            <p className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span className="text-slate-300">{formatChars(prompt.promptChars)} chars</span>
              <span>{formatTokens(prompt.promptChars)}</span>
              <span className="font-mono truncate max-w-[14rem]" title={prompt.promptFingerprint}>
                {prompt.promptFingerprint}
              </span>
              {prompt.redacted && (
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-200">
                  secrets redacted
                </span>
              )}
            </p>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading context…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</p>
          </div>
        ) : !view ? null : !view.captured ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-lg rounded-lg border border-slate-800 bg-slate-900/60 p-5 text-center">
              <p className="text-sm text-slate-300">No context was captured for this run.</p>
              <p className="mt-2 text-xs text-slate-500">
                Runs dispatched before context capture landed have no stored bundle. Newer runs of
                the same task will appear in the run picker above.
              </p>
            </div>
          </div>
        ) : tab === 'prompt' ? (
          <div className="flex h-full min-h-0">
            <aside className="w-72 shrink-0 overflow-y-auto border-r border-slate-800 bg-slate-900/40 p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Sections in prompt order
              </p>
              {prompt && (
                <SegmentOutline
                  segments={prompt.segments}
                  totalChars={prompt.promptChars}
                  activeKey={activeKey}
                  onSelect={outlineSelect}
                />
              )}
            </aside>
            <div ref={promptPaneRef} className="min-w-0 flex-1 overflow-y-auto p-4">
              {prompt && (
                <PromptPane
                  promptText={prompt.promptText}
                  segments={prompt.segments}
                  activeKey={activeKey}
                  onActivate={setActiveKey}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-4">
            <div className="mx-auto max-w-4xl">
              {tab === 'runtime' ? <RuntimePane runtime={view.runtime} /> : <DiffPane view={view} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
