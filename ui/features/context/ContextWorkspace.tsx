'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Layers, Loader2, Maximize2, Send, Trash2, X } from 'lucide-react';
import {
  api,
  ContextPublishConflict,
  type Agent,
  type AgentContextSources,
  type Project,
  type ContextRun,
  type ContextSegment,
  type InstanceContextView,
  type RecordedMcpServer,
  type TaskContextSources,
} from '@/lib/api';
import { formatDateTime } from '@/lib/date';
import { formatEstimatedTokens } from '@/lib/tokenCounts';
import { ContextViewer, PromptPane, SegmentOutline } from '@/features/tasks/ContextViewer';
import { segmentAnchorId } from '@/lib/contextViewer';
import { InstructionsAndSkills, TaskSection, ToolsSection, WorkflowAndProject } from './ContextSections';
import { useStagedChanges } from './stagedChanges';

type Tab = 'prompt' | 'instructions' | 'tools' | 'workflow' | 'task';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'instructions', label: 'Instructions & skills' },
  { id: 'tools', label: 'Tools' },
  { id: 'workflow', label: 'Workflow & project' },
  { id: 'task', label: 'Task' },
];

interface Selection {
  projectId: number | null;
  agentId: number | null;
  workflowId: number | null;
  taskType: string | null;
  runId: number | null;
}

function readSelection(): Selection {
  const params = new URLSearchParams(window.location.search);
  const number = (key: string) => {
    const value = Number(params.get(key));
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  return {
    projectId: number('project'),
    agentId: number('agent'),
    workflowId: number('workflow'),
    taskType: params.get('type') || null,
    runId: number('run'),
  };
}

function writeSelection(selection: Selection, tab: Tab) {
  const params = new URLSearchParams();
  if (selection.projectId) params.set('project', String(selection.projectId));
  if (selection.agentId) params.set('agent', String(selection.agentId));
  if (selection.workflowId) params.set('workflow', String(selection.workflowId));
  if (selection.taskType) params.set('type', selection.taskType);
  if (selection.runId) params.set('run', String(selection.runId));
  if (tab !== 'prompt') params.set('tab', tab);
  const query = params.toString();
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
}

function RailHeading({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 mt-4 text-[10px] font-semibold uppercase tracking-wide text-slate-500 first:mt-0">{children}</p>;
}

function railItem(active: boolean) {
  return `block w-full rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
    active ? 'bg-amber-500/15 text-amber-200' : 'text-slate-300 hover:bg-slate-800'
  }`;
}

export default function ContextWorkspace() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selection, setSelection] = useState<Selection>({ projectId: null, agentId: null, workflowId: null, taskType: null, runId: null });
  const [tab, setTab] = useState<Tab>('prompt');
  const [sources, setSources] = useState<AgentContextSources | null>(null);
  const [runs, setRuns] = useState<ContextRun[]>([]);
  const [runView, setRunView] = useState<InstanceContextView | null>(null);
  const [runServers, setRunServers] = useState<RecordedMcpServer[] | null>(null);
  const [task, setTask] = useState<TaskContextSources | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [showStaged, setShowStaged] = useState(false);
  const [viewerRunId, setViewerRunId] = useState<number | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const staged = useStagedChanges();

  useEffect(() => {
    const initial = readSelection();
    setSelection(initial);
    const initialTab = new URLSearchParams(window.location.search).get('tab') as Tab | null;
    if (initialTab && TABS.some((entry) => entry.id === initialTab)) setTab(initialTab);
    api.getProjects()
      .then((rows) => setProjects(rows.filter((project) => !project.archived_at).sort((a, b) => a.name.localeCompare(b.name))))
      .catch((err: Error) => setError(err.message));
    api.getAgents()
      .then((rows) => {
        const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
        setAgents(sorted);
        // A link that names only an agent still opens with its project chosen.
        setSelection((previous) => {
          if (previous.projectId || !previous.agentId) return previous;
          const projectId = sorted.find((agent) => agent.id === previous.agentId)?.project_id ?? null;
          return projectId ? { ...previous, projectId } : previous;
        });
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const projectAgents = useMemo(
    () => (selection.projectId ? agents.filter((agent) => agent.project_id === selection.projectId) : agents),
    [agents, selection.projectId],
  );

  useEffect(() => { writeSelection(selection, tab); }, [selection, tab]);

  // Agent sources: instructions, skills, tools, workflows.
  useEffect(() => {
    if (!selection.agentId) { setSources(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getAgentContextSources(selection.agentId)
      .then((data) => { if (!cancelled) setSources(data); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selection.agentId, reloadToken]);

  // Recorded runs for the current filter; the newest is selected when none is.
  useEffect(() => {
    if (!selection.agentId) { setRuns([]); return; }
    let cancelled = false;
    api.getContextRuns({
      projectId: selection.projectId,
      agentId: selection.agentId,
      workflowId: selection.workflowId,
      taskType: selection.taskType,
      limit: 40,
    })
      .then((rows) => {
        if (cancelled) return;
        setRuns(rows);
        setSelection((previous) => (
          previous.runId && rows.some((run) => run.instanceId === previous.runId)
            ? previous
            : { ...previous, runId: rows[0]?.instanceId ?? null }
        ));
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selection.projectId, selection.agentId, selection.workflowId, selection.taskType, reloadToken]);

  const selectedRun = useMemo(() => runs.find((run) => run.instanceId === selection.runId) ?? null, [runs, selection.runId]);

  useEffect(() => {
    if (!selection.runId) { setRunView(null); setRunServers(null); return; }
    let cancelled = false;
    api.getInstanceContext(selection.runId, { diff: false })
      .then((view) => { if (!cancelled) setRunView(view); })
      .catch(() => { if (!cancelled) setRunView(null); });
    api.getRunMcpTools(selection.runId)
      .then((servers) => { if (!cancelled) setRunServers(servers.length ? servers : null); })
      .catch(() => { if (!cancelled) setRunServers(null); });
    return () => { cancelled = true; };
  }, [selection.runId]);

  useEffect(() => {
    const taskId = selectedRun?.taskId;
    if (!taskId) { setTask(null); return; }
    let cancelled = false;
    api.getTaskContextSources(taskId)
      .then((data) => { if (!cancelled) setTask(data); })
      .catch(() => { if (!cancelled) setTask(null); });
    return () => { cancelled = true; };
  }, [selectedRun?.taskId, reloadToken]);

  const selectAgent = (agentId: number) => {
    if (agentId === selection.agentId) return;
    if (staged.list.length > 0 && !window.confirm('Switching agent keeps your staged changes. Continue?')) return;
    setSelection((previous) => ({ projectId: previous.projectId, agentId, workflowId: null, taskType: null, runId: null }));
  };

  const selectProject = (projectId: number | null) => {
    if (projectId === selection.projectId) return;
    setSelection((previous) => {
      // Keep the agent when it belongs to the new project; otherwise start over at the agent.
      const keep = previous.agentId && (projectId === null
        || agents.find((agent) => agent.id === previous.agentId)?.project_id === projectId);
      return keep
        ? { ...previous, projectId, workflowId: null, taskType: null, runId: null }
        : { projectId, agentId: null, workflowId: null, taskType: null, runId: null };
    });
  };

  const workflows = useMemo(
    () => (sources?.workflows ?? []).filter((entry) => !selection.projectId || entry.projectId === selection.projectId),
    [sources, selection.projectId],
  );
  const workflow = workflows.find((entry) => entry.id === selection.workflowId) ?? null;

  const publish = useCallback(async () => {
    setPublishing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.publishContextChanges(staged.list.map((entry) => entry.change));
      staged.discardAll();
      const names = result.republished
        .map((entry) => agents.find((agent) => agent.id === entry.agentId)?.name ?? `agent ${entry.agentId}`);
      setNotice(`Published ${result.applied.length} change(s).${names.length ? ` Re-approved ${names.join(', ')} for its next run.` : ''}`);
      setReloadToken((value) => value + 1);
    } catch (err) {
      if (err instanceof ContextPublishConflict) {
        staged.markConflicts(err.conflicts);
        setShowStaged(true);
        setError(`${err.message} Nothing was published.`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setPublishing(false);
    }
  }, [agents, staged]);

  const prompt = runView?.prompt ?? null;
  const outlineSelect = (segment: ContextSegment, injectedIndex: number) => {
    if (!segment.injected || !prompt) return;
    setActiveKey(`${segment.kind}-${prompt.segments.indexOf(segment)}`);
    requestAnimationFrame(() => {
      document.getElementById(segmentAnchorId(segment.kind, injectedIndex))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-950 text-slate-100">
      <header className="shrink-0 border-b border-slate-800 px-4 py-3">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Layers className="h-4 w-4 text-amber-400" /> Context
        </h1>
        <p className="mt-0.5 text-xs text-slate-400">
          See what an agent is given on each run and edit the sources. Edits stay staged until you publish them together.
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="max-h-56 w-full shrink-0 overflow-y-auto border-b border-slate-800 bg-slate-900/40 p-3 md:max-h-none md:w-64 md:border-b-0 md:border-r">
          <RailHeading>Project</RailHeading>
          <select
            value={selection.projectId ?? ''}
            onChange={(event) => selectProject(event.target.value ? Number(event.target.value) : null)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} ({agents.filter((agent) => agent.project_id === project.id).length})
              </option>
            ))}
          </select>

          <RailHeading>Agent</RailHeading>
          <select
            value={selection.agentId ?? ''}
            onChange={(event) => selectAgent(Number(event.target.value))}
            className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="" disabled>{projectAgents.length ? 'Choose an agent…' : 'No agents in this project'}</option>
            {selection.projectId
              ? projectAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)
              : projects.map((project) => {
                  const members = agents.filter((agent) => agent.project_id === project.id);
                  return members.length ? (
                    <optgroup key={project.id} label={project.name}>
                      {members.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </optgroup>
                  ) : null;
                })}
            {!selection.projectId && agents.some((agent) => !projects.some((project) => project.id === agent.project_id)) && (
              <optgroup label="No active project">
                {agents.filter((agent) => !projects.some((project) => project.id === agent.project_id))
                  .map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </optgroup>
            )}
          </select>

          {sources && (
            <>
              <RailHeading>Workflow</RailHeading>
              <button type="button" className={railItem(!selection.workflowId)} onClick={() => setSelection((previous) => ({ ...previous, workflowId: null, taskType: null, runId: null }))}>
                All workflows
              </button>
              {workflows.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={railItem(selection.workflowId === entry.id)}
                  onClick={() => setSelection((previous) => ({ ...previous, workflowId: entry.id, taskType: null, runId: null }))}
                >
                  {entry.name}
                  <span className="ml-1 text-[10px] text-slate-500">{entry.runCount} runs</span>
                </button>
              ))}
            </>
          )}

          {workflow && workflow.taskTypes.length > 0 && (
            <>
              <RailHeading>Task type</RailHeading>
              <div className="flex flex-wrap gap-1">
                {[null, ...workflow.taskTypes].map((type) => (
                  <button
                    key={type ?? 'all'}
                    type="button"
                    onClick={() => setSelection((previous) => ({ ...previous, taskType: type, runId: null }))}
                    className={`rounded-full px-2 py-0.5 text-[11px] ${selection.taskType === type ? 'bg-amber-500/20 text-amber-200' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                  >
                    {type ?? 'all'}
                  </button>
                ))}
              </div>
            </>
          )}

          {selection.agentId && (
            <>
              <RailHeading>Recorded runs</RailHeading>
              {runs.length === 0 && <p className="text-xs text-slate-500">No recorded runs for this filter.</p>}
              {runs.map((run) => (
                <button
                  key={run.instanceId}
                  type="button"
                  className={railItem(selection.runId === run.instanceId)}
                  onClick={() => setSelection((previous) => ({ ...previous, runId: run.instanceId }))}
                >
                  <span className="block truncate">{run.taskId ? `#${run.taskId} ${run.taskTitle ?? ''}` : `Run #${run.instanceId}`}</span>
                  <span className="block text-[10px] text-slate-500">
                    {run.createdAt ? formatDateTime(run.createdAt) : ''} · {formatEstimatedTokens(run.promptChars)} · {run.status}
                  </span>
                </button>
              ))}
            </>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <nav className="flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-800 px-4 py-2">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium ${tab === entry.id ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
              >
                {entry.label}
              </button>
            ))}
            {selection.runId && (
              <button
                type="button"
                onClick={() => setViewerRunId(selection.runId)}
                className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-amber-500/40 hover:text-amber-300"
                title="Open this run in the full viewer, with the runtime boundary and the diff against the previous run"
              >
                <Maximize2 className="h-3 w-3" /> Full viewer
              </button>
            )}
          </nav>

          {(error || notice) && (
            <div className={`mx-4 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${error ? 'border-red-500/30 bg-red-950/30 text-red-200' : 'border-emerald-500/30 bg-emerald-950/30 text-emerald-200'}`}>
              {error && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span className="flex-1">{error ?? notice}</span>
              <button type="button" onClick={() => { setError(null); setNotice(null); }} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!selection.agentId ? (
              <p className="text-sm text-slate-400">Choose a project and an agent to see the agent’s context.</p>
            ) : loading && !sources ? (
              <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
            ) : !sources ? null : tab === 'prompt' ? (
              !prompt ? (
                <p className="text-sm text-slate-400">{selection.runId ? 'No prompt was captured for this run.' : 'Pick a recorded run to see its prompt.'}</p>
              ) : (
                <div className="flex gap-4">
                  <aside className="hidden w-64 shrink-0 xl:block">
                    <SegmentOutline segments={prompt.segments} totalChars={prompt.promptChars} activeKey={activeKey} onSelect={outlineSelect} />
                  </aside>
                  <div className="min-w-0 flex-1">
                    <p className="mb-2 text-[11px] text-slate-500">
                      Run #{runView?.instanceId} · {formatEstimatedTokens(prompt.promptChars)} in the prompt Agent HQ wrote.
                      The runtime adds its own system prompt, the skill list and tool definitions on top (see Tools).
                    </p>
                    <PromptPane promptText={prompt.promptText} segments={prompt.segments} activeKey={activeKey} onActivate={setActiveKey} />
                  </div>
                </div>
              )
            ) : tab === 'instructions' ? (
              <InstructionsAndSkills sources={sources} staged={staged} />
            ) : tab === 'tools' ? (
              <ToolsSection sources={sources} runServers={runServers} staged={staged} />
            ) : tab === 'workflow' ? (
              <WorkflowAndProject sources={sources} workflowId={selection.workflowId ?? selectedRun?.workflowId ?? null} staged={staged} />
            ) : (
              <TaskSection task={task} staged={staged} />
            )}
          </div>

          {staged.list.length > 0 && (
            <footer className="shrink-0 border-t border-amber-500/30 bg-slate-900 px-4 py-2.5">
              {showStaged && (
                <ul className="mb-2 max-h-48 space-y-1 overflow-y-auto text-xs">
                  {staged.list.map((entry) => (
                    <li key={entry.key} className="flex items-center gap-2">
                      <span className={entry.conflictHash ? 'text-red-300' : 'text-slate-200'}>{entry.label}</span>
                      {entry.conflictHash && (
                        <>
                          <span className="text-red-300">changed by someone else since you loaded it</span>
                          <button type="button" onClick={() => staged.overwrite(entry.key)} className="rounded border border-red-500/40 px-1.5 text-red-200 hover:bg-red-500/10">
                            Publish mine over it
                          </button>
                        </>
                      )}
                      <button type="button" onClick={() => staged.discard(entry.key)} className="ml-auto text-slate-500 hover:text-red-300" title="Discard this change">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setShowStaged((value) => !value)} className="text-xs text-amber-200 hover:underline">
                  {staged.list.length} staged change{staged.list.length === 1 ? '' : 's'}
                </button>
                <span className="text-[11px] text-slate-500">Published together, or not at all.</span>
                <button
                  type="button"
                  onClick={() => staged.discardAll()}
                  disabled={publishing}
                  className="ml-auto rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-red-500/40 hover:text-red-300 disabled:opacity-40"
                >
                  Discard all
                </button>
                <button
                  type="button"
                  onClick={() => void publish()}
                  disabled={publishing || staged.list.some((entry) => entry.conflictHash)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
                >
                  {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Publish all
                </button>
              </div>
            </footer>
          )}
        </div>
      </div>

      {viewerRunId && <ContextViewer instanceId={viewerRunId} onClose={() => setViewerRunId(null)} />}
    </div>
  );
}
