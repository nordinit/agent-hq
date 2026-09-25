'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, type HistoricalTrace, type Project, type Workflow, type WorkflowType } from '@/lib/api';
import { formatWorkflowNumber } from '@/lib/workflowLabel';
import { useWorkflowOutcomeCatalog } from '@/lib/useWorkflowOutcomeCatalog';
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
import { formatWorkflowTypeLabel } from '@/features/routing/workflowConfigShared';
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
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowTypes, setWorkflowTypes] = useState<WorkflowType[]>([]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProjectId, setSelectedProjectId] = useProjectFilterPreference({ validProjectIds });
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RoutingTab>('graph');
  const workflowScopedTabs: RoutingTab[] = ['graph', 'rules', 'transitions', 'transition-reqs'];
  const [selectedWorkflowType, setSelectedWorkflowType] = useState<string | null>(null);
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null;
  const selectedWorkflow = workflows.find(workflow => workflow.id === selectedWorkflowId) ?? null;
  const selectedWorkflowMatchesProject = selectedProjectId !== null
    && selectedWorkflow !== null
    && selectedWorkflow.project_id === selectedProjectId;
  const projectScopedWorkflows = selectedProjectId
    ? workflows.filter(workflow => workflow.project_id === selectedProjectId)
    : workflows;
  const availableWorkflowTypes = useMemo(() => getRoutingWorkflowTypeOptions(workflowTypes), [workflowTypes]);
  const availableWorkflowTypeKeys = useMemo(() => availableWorkflowTypes.map(type => type.key), [availableWorkflowTypes]);
  const effectiveWorkflowType = selectedWorkflowMatchesProject
    ? (selectedWorkflow.workflow_type ?? selectedWorkflowType)
    : selectedWorkflowType;
  const scopedWorkflowId = selectedWorkflowMatchesProject ? selectedWorkflowId : null;
  const scopedWorkflowName = selectedWorkflowMatchesProject ? selectedWorkflow.name : null;
  const scopedWorkflowType = effectiveWorkflowType ?? null;
  const outcomeCatalog = useWorkflowOutcomeCatalog(scopedWorkflowType);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getProjects(),
      api.getWorkflows(undefined, true),
      api.getWorkflowTypes(),
    ])
      .then(([projectList, workflowList, workflowTypeList]) => {
        setProjects(projectList);
        setWorkflows(workflowList);
        setWorkflowTypes(workflowTypeList);
        setSelectedWorkflowId(current => {
          if (current && workflowList.some(workflow => workflow.id === current)) return current;
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
        if (result.task.workflow_type) setSelectedWorkflowType(result.task.workflow_type);
        if (result.task.workflow_id) setSelectedWorkflowId(result.task.workflow_id);
      })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [traceTaskId, setSelectedProjectId]);

  useEffect(() => {
    setSelectedWorkflowType(current => {
      if (current && availableWorkflowTypeKeys.includes(current)) return current;
      return availableWorkflowTypeKeys[0] ?? null;
    });
  }, [availableWorkflowTypeKeys]);

  useEffect(() => {
    // A replay pins the scope to the traced task's own workflow. Without this guard
    // the reset below races the trace load: projectScopedWorkflows is still empty on
    // mount, so the workflow the trace just selected gets cleared and the graph falls
    // back to type defaults — which for most projects means no transitions at all.
    if (historicalTrace?.task.workflow_id) return;
    setSelectedWorkflowId(current => {
      if (!selectedWorkflowType) return null;
      if (current && projectScopedWorkflows.some(workflow => workflow.id === current && workflow.workflow_type === selectedWorkflowType)) return current;
      return null;
    });
  }, [projectScopedWorkflows, selectedWorkflowType, historicalTrace]);

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
  // resolved flattens the base outcomes plus one copy per task type, so the same key recurs
  // once per type. Without the dedupe the composer lists every outcome about ten times.
  const graphOutcomeKeys = [...new Set(outcomeCatalog.resolved.map(outcome => outcome.outcome_key))].sort();
  const filteredWorkflows = selectedProjectId && scopedWorkflowType
    ? workflows.filter(workflow => workflow.project_id === selectedProjectId && workflow.workflow_type === scopedWorkflowType)
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

      {(workflowScopedTabs.includes(activeTab) || activeTab === 'external-events') && (
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
                    value={selectedWorkflowType ?? ''}
                    onChange={e => setSelectedWorkflowType(e.target.value || null)}
                    disabled={availableWorkflowTypes.length === 0}
                  >
                    <option value="">Select workflow type…</option>
                    {availableWorkflowTypes.map(type => (
                      <option key={type.key} value={type.key}>
                        {type.name || formatWorkflowTypeLabel(type.key)}
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
                    value={scopedWorkflowId ?? ''}
                    onChange={e => setSelectedWorkflowId(e.target.value ? Number(e.target.value) : null)}
                    disabled={filteredWorkflows.length === 0}
                  >
                    <option value="">{selectedWorkflowType ? 'All (default)' : 'Select workflow type first…'}</option>
                    {filteredWorkflows.map(workflow => (
                      <option key={workflow.id} value={workflow.id}>
                        {formatWorkflowNumber(workflow.id)} · {workflow.name}
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
      <div className="border-b border-slate-700/50 overflow-x-auto scrollbar-none" data-tour-target="routing-tabs">
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
          workflowId={scopedWorkflowId}
          workflowName={scopedWorkflowName}
          workflowType={scopedWorkflowType}
          outcomeCatalog={graphOutcomeKeys}
          workflowCount={filteredWorkflows.length}
          historicalTrace={historicalTrace}
          onClearHistoricalTrace={() => {
            setHistoricalTrace(null);
            window.history.replaceState(null, '', '/routing');
          }}
        />
      )}

      {activeTab === 'rules' && (
        <RoutingRulesSection projectId={selectedProjectId} workflowId={scopedWorkflowId} workflowName={scopedWorkflowName} workflowType={scopedWorkflowType} />
      )}

      {activeTab === 'transitions' && (
        <TransitionsSection
          projectId={selectedProjectId}
          workflowId={scopedWorkflowId}
          workflowName={scopedWorkflowName}
          workflowType={scopedWorkflowType}
          outcomeCatalog={outcomeCatalog}
        />
      )}

      {activeTab === 'transition-reqs' && (
        <TransitionRequirementsSection
          projectId={selectedProjectId}
          workflowId={scopedWorkflowId}
          workflowType={scopedWorkflowType}
          workflowName={scopedWorkflowName}
          outcomeCatalog={outcomeCatalog}
        />
      )}

      {activeTab === 'external-events' && (
        <ExternalEventsRoutingSection
          projectId={selectedProjectId}
          projectName={selectedProject?.name ?? null}
          workflowId={scopedWorkflowId}
          workflowType={scopedWorkflowType}
        />
      )}

      {activeTab === 'agent-contract' && (
        <AgentContractSection />
      )}
    </div>
  );
}
