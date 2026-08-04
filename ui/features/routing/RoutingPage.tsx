'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, type HistoricalTrace, type Project, type Sprint, type SprintType } from '@/lib/api';
import { formatSprintNumber } from '@/lib/sprintLabel';
import { useSprintOutcomeCatalog } from '@/lib/useSprintOutcomeCatalog';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';
import { getRoutingWorkflowTypeOptions } from '@/lib/routingWorkflowTypes';
import { Card } from '@/components/ui/card';
import { SCOPE_CARD_CLASS } from '@/components/workflowConfig';
import ExternalEventsRoutingSection from '@/features/routing/ExternalEventsRoutingSection';
import AgentContractSection from '@/features/routing/sections/AgentContractSection';
import RoutingRulesSection from '@/features/routing/sections/RoutingRulesSection';
import TransitionRequirementsSection from '@/features/routing/sections/TransitionRequirementsSection';
import TransitionsSection from '@/features/routing/sections/TransitionsSection';
import WorkflowGraphSection from '@/features/routing/sections/WorkflowGraphSection';
import { formatSprintTypeLabel } from '@/features/routing/workflowConfigShared';
import { ChevronDown, GitBranch } from 'lucide-react';

type RoutingTab = 'graph' | 'rules' | 'transitions' | 'transition-reqs' | 'external-events' | 'agent-contract';

// ─── Main Page ───────────────────────────────────────────────
export default function RoutingPage() {
  const searchParams = useSearchParams();
  // ?trace_task=<id> opens the graph replaying that task's path. The task modal
  // deep-links here rather than embedding a second canvas of its own.
  const traceTaskId = Number(searchParams?.get('trace_task') ?? '');
  const [historicalTrace, setHistoricalTrace] = useState<HistoricalTrace | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [sprintTypes, setSprintTypes] = useState<SprintType[]>([]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProjectId, setSelectedProjectId] = useProjectFilterPreference({ validProjectIds });
  const [selectedSprintId, setSelectedSprintId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RoutingTab>('graph');
  const sprintScopedTabs: RoutingTab[] = ['graph', 'rules', 'transitions', 'transition-reqs'];
  const [selectedSprintType, setSelectedSprintType] = useState<string | null>(null);
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null;
  const selectedSprint = sprints.find(sprint => sprint.id === selectedSprintId) ?? null;
  const selectedSprintMatchesProject = selectedProjectId !== null
    && selectedSprint !== null
    && selectedSprint.project_id === selectedProjectId;
  const projectScopedSprints = selectedProjectId
    ? sprints.filter(sprint => sprint.project_id === selectedProjectId)
    : sprints;
  const availableSprintTypes = useMemo(() => getRoutingWorkflowTypeOptions(sprintTypes), [sprintTypes]);
  const availableSprintTypeKeys = useMemo(() => availableSprintTypes.map(type => type.key), [availableSprintTypes]);
  const effectiveSprintType = selectedSprintMatchesProject
    ? (selectedSprint.sprint_type ?? selectedSprintType)
    : selectedSprintType;
  const scopedSprintId = selectedSprintMatchesProject ? selectedSprintId : null;
  const scopedSprintName = selectedSprintMatchesProject ? selectedSprint.name : null;
  const scopedSprintType = effectiveSprintType ?? null;
  const outcomeCatalog = useSprintOutcomeCatalog(scopedSprintType);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getProjects(),
      api.getSprints(undefined, true),
      api.getSprintTypes(),
    ])
      .then(([projectList, sprintList, sprintTypeList]) => {
        setProjects(projectList);
        setSprints(sprintList);
        setSprintTypes(sprintTypeList);
        setSelectedSprintId(current => {
          if (current && sprintList.some(sprint => sprint.id === current)) return current;
          return null;
        });
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Loading a replay also decides the scope: a task's path only makes sense against
  // the graph for its own project and workflow, so those selectors follow the task.
  useEffect(() => {
    if (!Number.isFinite(traceTaskId) || traceTaskId <= 0) {
      setHistoricalTrace(null);
      return;
    }
    let cancelled = false;
    api.getTaskTrace(traceTaskId)
      .then(result => {
        if (cancelled) return;
        setHistoricalTrace(result);
        setActiveTab('graph');
        if (result.task.project_id) setSelectedProjectId(result.task.project_id);
        if (result.task.sprint_type) setSelectedSprintType(result.task.sprint_type);
        if (result.task.sprint_id) setSelectedSprintId(result.task.sprint_id);
      })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [traceTaskId, setSelectedProjectId]);

  useEffect(() => {
    setSelectedSprintType(current => {
      if (current && availableSprintTypeKeys.includes(current)) return current;
      return availableSprintTypeKeys[0] ?? null;
    });
  }, [availableSprintTypeKeys]);

  useEffect(() => {
    // A replay pins the scope to the traced task's own workflow. Without this guard
    // the reset below races the trace load: projectScopedSprints is still empty on
    // mount, so the workflow the trace just selected gets cleared and the graph falls
    // back to type defaults — which for most projects means no transitions at all.
    if (historicalTrace?.task.sprint_id) return;
    setSelectedSprintId(current => {
      if (!selectedSprintType) return null;
      if (current && projectScopedSprints.some(sprint => sprint.id === current && sprint.sprint_type === selectedSprintType)) return current;
      return null;
    });
  }, [projectScopedSprints, selectedSprintType, historicalTrace]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  const tabs: { id: RoutingTab; label: string; count?: number }[] = [
    { id: 'graph', label: 'Graph' },
    { id: 'rules', label: 'Assignment Rules' },
    { id: 'transitions', label: 'Automatic Transitions' },
    { id: 'transition-reqs', label: 'Gate Requirements' },
    { id: 'external-events', label: 'Workflow Events' },
    { id: 'agent-contract', label: 'Agent Contract' },
  ];
  const filteredSprints = selectedProjectId && scopedSprintType
    ? sprints.filter(sprint => sprint.project_id === selectedProjectId && sprint.sprint_type === scopedSprintType)
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <GitBranch className="w-5 h-5 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">Task Routing</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Workflow configuration: workflow-scoped task policy for assignment, transitions, gate requirements, and event mappings
        </p>
      </div>

      {(sprintScopedTabs.includes(activeTab) || activeTab === 'external-events') && (
        <Card className={SCOPE_CARD_CLASS}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">
                {activeTab === 'external-events' ? 'Project Scope' : 'Workflow Scope'}
              </p>
              <p className="mt-1 text-base font-semibold text-white">
                {activeTab === 'external-events'
                  ? 'Workflow event mappings are global or project-scoped.'
                  : 'Default policy is managed at project + workflow type scope, with optional workflow overrides.'}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {activeTab === 'external-events'
                  ? 'Select All Projects for global workflow-event mappings, or choose a project for project-specific behavior. The workflow selector only drives workflow-aware status and outcome suggestions in the editor.'
                  : 'Select All Projects for global/default routing context, or choose a project and workflow type to manage project-scoped rules. Pick a workflow only when you need workflow-level exceptions layered on top.'}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[860px]">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Project</p>
                <div className="relative">
                  <select
                    className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
                    value={selectedProjectId ?? ''}
                    onChange={e => setSelectedProjectId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">All Projects</option>
                    {projects.map(project => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Workflow type</p>
                <div className="relative">
                  <select
                    className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-60"
                    value={selectedSprintType ?? ''}
                    onChange={e => setSelectedSprintType(e.target.value || null)}
                    disabled={availableSprintTypes.length === 0}
                  >
                    <option value="">Select workflow type…</option>
                    {availableSprintTypes.map(type => (
                      <option key={type.key} value={type.key}>
                        {type.name || formatSprintTypeLabel(type.key)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Workflow</p>
                <div className="relative">
                  <select
                    className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-60"
                    value={scopedSprintId ?? ''}
                    onChange={e => setSelectedSprintId(e.target.value ? Number(e.target.value) : null)}
                    disabled={filteredSprints.length === 0}
                  >
                    <option value="">{selectedSprintType ? 'All (default)' : 'Select workflow type first…'}</option>
                    {filteredSprints.map(sprint => (
                      <option key={sprint.id} value={sprint.id}>
                        {formatSprintNumber(sprint.id)} · {sprint.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Tabs — scrollable on mobile */}
      <div className="border-b border-slate-700/50 overflow-x-auto scrollbar-none">
        <div className="flex gap-1 min-w-max">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-amber-400 text-amber-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  activeTab === tab.id ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700 text-slate-500'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'graph' && (
        <WorkflowGraphSection
          projectId={selectedProjectId}
          sprintId={scopedSprintId}
          sprintName={scopedSprintName}
          sprintType={scopedSprintType}
          historicalTrace={historicalTrace}
          onClearHistoricalTrace={() => {
            setHistoricalTrace(null);
            window.history.replaceState(null, '', '/routing');
          }}
        />
      )}

      {activeTab === 'rules' && (
        <RoutingRulesSection projectId={selectedProjectId} sprintId={scopedSprintId} sprintName={scopedSprintName} sprintType={scopedSprintType} />
      )}

      {activeTab === 'transitions' && (
        <TransitionsSection
          projectId={selectedProjectId}
          sprintId={scopedSprintId}
          sprintName={scopedSprintName}
          sprintType={scopedSprintType}
          outcomeCatalog={outcomeCatalog}
        />
      )}

      {activeTab === 'transition-reqs' && (
        <TransitionRequirementsSection
          projectId={selectedProjectId}
          sprintId={scopedSprintId}
          sprintType={scopedSprintType}
          sprintName={scopedSprintName}
          outcomeCatalog={outcomeCatalog}
        />
      )}

      {activeTab === 'external-events' && (
        <ExternalEventsRoutingSection
          projectId={selectedProjectId}
          projectName={selectedProject?.name ?? null}
          sprintId={scopedSprintId}
          sprintType={scopedSprintType}
        />
      )}

      {activeTab === 'agent-contract' && (
        <AgentContractSection />
      )}
    </div>
  );
}
