'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronDown,
  ExternalLink,
  History,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  X,
  Zap,
} from 'lucide-react';
import { api, type Agent, type Project, type RecurringTaskOverlapPolicy, type RecurringTaskRun, type RecurringTaskSeries, type RecurringTaskSeriesInput, type Sprint } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/date';
import {
  buildScheduleExpression,
  formatScheduleExpression,
  MINUTE_INTERVAL_MAX,
  MINUTE_INTERVAL_MIN,
  parseScheduleExpression,
  shouldClearLoadedWorkflowSelection,
  validateMinuteInterval,
  type RecurringScheduleKind,
} from '@/lib/recurringTaskSchedule';
import { formatSprintLabel } from '@/lib/sprintLabel';
import { useTaskTypes } from '@/lib/taskTypes';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';

type SeriesForm = {
  id?: number;
  title_template: string;
  description_template: string;
  project_id: number | '';
  sprint_id: number | '';
  task_type: string;
  priority: 'low' | 'medium' | 'high';
  story_points: number;
  status_on_create: string;
  schedule_kind: RecurringScheduleKind;
  minute_interval: number | '';
  weekday: string;
  schedule_time: string;
  custom_schedule: string;
  timezone: string;
  enabled: boolean;
  overlap_policy: RecurringTaskOverlapPolicy;
  agent_id: number | '';
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

function emptyForm(projectId: number | null): SeriesForm {
  return {
    title_template: '',
    description_template: '',
    project_id: projectId ?? '',
    sprint_id: '',
    task_type: '',
    priority: 'medium',
    story_points: 1,
    status_on_create: '',
    schedule_kind: 'daily',
    minute_interval: MINUTE_INTERVAL_MIN,
    weekday: 'monday',
    schedule_time: '09:00',
    custom_schedule: '',
    timezone: DEFAULT_TIMEZONE,
    enabled: true,
    overlap_policy: 'skip_if_active',
    agent_id: '',
  };
}

function formFromSeries(series: RecurringTaskSeries): SeriesForm {
  return {
    id: series.id,
    title_template: series.title_template ?? '',
    description_template: series.description_template ?? '',
    project_id: series.project_id,
    sprint_id: series.sprint_id,
    task_type: series.task_type ?? '',
    priority: series.priority ?? 'medium',
    story_points: series.story_points ?? 1,
    status_on_create: series.status_on_create ?? '',
    timezone: series.timezone ?? DEFAULT_TIMEZONE,
    enabled: Boolean(series.enabled),
    overlap_policy: series.overlap_policy ?? 'skip_if_active',
    agent_id: series.agent_id ?? '',
    ...parseScheduleExpression(series.schedule_expression ?? series.schedule ?? ''),
  };
}

function badgeClass(tone: 'green' | 'amber' | 'red' | 'slate' | 'cyan') {
  const tones = {
    green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    red: 'border-red-500/30 bg-red-500/10 text-red-300',
    slate: 'border-slate-600 bg-slate-800 text-slate-300',
    cyan: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  };
  return `inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`;
}

function runTone(status: string | null | undefined): 'green' | 'amber' | 'red' | 'slate' | 'cyan' {
  if (status === 'created') return 'green';
  if (status === 'started') return 'cyan';
  if (status === 'skipped') return 'amber';
  if (status === 'failed') return 'red';
  return 'slate';
}

function relativeTimeLabel(value: string | null | undefined) {
  if (!value) return '-';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return '-';
  return date.getTime() > Date.now() ? formatDateTime(value) : timeAgo(value);
}

function fieldClass(hasError?: boolean) {
  return `w-full rounded-lg border bg-slate-800 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-amber-400 disabled:opacity-60 ${hasError ? 'border-red-500/70' : 'border-slate-600'}`;
}

function ErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-[11px] text-red-300">{message}</p>;
}

function SeriesModal({
  form,
  projects,
  sprints,
  agents,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  form: SeriesForm;
  projects: Project[];
  sprints: Sprint[];
  agents: Agent[];
  saving: boolean;
  error: string | null;
  onChange: (next: SeriesForm) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { options: taskTypes, loading: taskTypesLoading } = useTaskTypes(form.sprint_id || null);
  const { metadata, loading: workflowMetadataLoading } = useWorkflowMetadata(form.sprint_id || null, { taskType: form.task_type || null });
  const statuses = metadata.statuses;
  const taskTypeValues = useMemo(() => taskTypes.map(option => option.value), [taskTypes]);
  const statusValues = useMemo(() => statuses.map(status => status.name), [statuses]);
  const selectedProjectSprints = sprints.filter(sprint => sprint.project_id === form.project_id);
  const projectAgents = agents.filter(agent => !form.project_id || agent.project_id === form.project_id || agent.project_id == null);
  const validation = {
    title_template: form.title_template.trim() ? undefined : 'Task title template is required.',
    project_id: form.project_id ? undefined : 'Choose the project that will own generated tasks.',
    sprint_id: form.sprint_id ? undefined : 'Choose a fixed workflow. Active-workflow selection is not available in v1.',
    task_type: form.task_type ? undefined : 'Choose a task type for the selected workflow.',
    status_on_create: form.status_on_create ? undefined : 'Choose the initial status for generated tasks.',
    minute_interval: form.schedule_kind === 'minutes' ? validateMinuteInterval(form.minute_interval) : undefined,
    schedule_time: form.schedule_kind === 'daily' || form.schedule_kind === 'weekly'
      ? (/^([01]\d|2[0-3]):[0-5]\d$/.test(form.schedule_time) ? undefined : 'Use 24-hour HH:mm time.')
      : undefined,
    custom_schedule: form.schedule_kind === 'custom' && !form.custom_schedule.trim() ? 'Schedule expression is required.' : undefined,
    timezone: form.timezone.trim() ? undefined : 'Timezone is required.',
  };

  useEffect(() => {
    if (shouldClearLoadedWorkflowSelection(form.task_type, taskTypeValues, taskTypesLoading)) {
      onChange({ ...form, task_type: '', status_on_create: '' });
      return;
    }
    if (shouldClearLoadedWorkflowSelection(form.status_on_create, statusValues, workflowMetadataLoading)) {
      onChange({ ...form, status_on_create: '' });
    }
  }, [form, onChange, statusValues, taskTypeValues, taskTypesLoading, workflowMetadataLoading]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 p-3 backdrop-blur-sm sm:flex sm:items-center sm:justify-center sm:p-4">
      <div className="flex h-full max-h-[calc(100vh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl sm:h-auto sm:max-h-[90vh]">
        <div className="flex items-start justify-between border-b border-slate-700 px-4 py-3 sm:px-6">
          <div>
            <h2 className="text-base font-semibold text-white">{form.id ? 'Edit Recurring Task Series' : 'Create Recurring Task Series'}</h2>
            <p className="mt-1 text-xs text-slate-400">Schedules create normal tasks in the fixed workflow. Routing and agent runs happen later through task workflow rules.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:text-white" aria-label="Close recurring task form">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <Settings2 className="h-3.5 w-3.5 text-amber-400" />
              Task Template
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Title *</label>
              <input className={fieldClass(Boolean(validation.title_template))} value={form.title_template} onChange={e => onChange({ ...form, title_template: e.target.value })} placeholder="Weekly workflow review prep" />
              <ErrorText message={validation.title_template} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Description</label>
              <textarea className={`${fieldClass()} h-24 resize-none`} value={form.description_template} onChange={e => onChange({ ...form, description_template: e.target.value })} placeholder="Details copied onto each generated task." />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Project *</label>
                <select className={fieldClass(Boolean(validation.project_id))} value={form.project_id} onChange={e => onChange({ ...form, project_id: e.target.value ? Number(e.target.value) : '', sprint_id: '', task_type: '', status_on_create: '', agent_id: '' })}>
                  <option value="">Select project</option>
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
                <ErrorText message={validation.project_id} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Fixed Workflow *</label>
                <select className={fieldClass(Boolean(validation.sprint_id))} value={form.sprint_id} onChange={e => onChange({ ...form, sprint_id: e.target.value ? Number(e.target.value) : '', task_type: '', status_on_create: '' })} disabled={!form.project_id}>
                  <option value="">{form.project_id ? 'Select fixed workflow' : 'Select project first'}</option>
                  {selectedProjectSprints.map(sprint => <option key={sprint.id} value={sprint.id}>{formatSprintLabel(sprint)} ({sprint.status})</option>)}
                </select>
                <ErrorText message={validation.sprint_id} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Task Type *</label>
                <select className={fieldClass(Boolean(validation.task_type))} value={form.task_type} onChange={e => onChange({ ...form, task_type: e.target.value, status_on_create: '' })} disabled={!form.sprint_id}>
                  <option value="">{form.sprint_id ? 'Select task type' : 'Select workflow first'}</option>
                  {form.task_type && !taskTypeValues.includes(form.task_type) && taskTypesLoading && <option value={form.task_type}>{form.task_type}</option>}
                  {taskTypes.map(taskType => <option key={taskType.value} value={taskType.value}>{taskType.label}</option>)}
                </select>
                <ErrorText message={validation.task_type} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Status On Create *</label>
                <select className={fieldClass(Boolean(validation.status_on_create))} value={form.status_on_create} onChange={e => onChange({ ...form, status_on_create: e.target.value })} disabled={!form.sprint_id}>
                  <option value="">{form.sprint_id ? 'Select initial status' : 'Select workflow first'}</option>
                  {form.status_on_create && !statusValues.includes(form.status_on_create) && workflowMetadataLoading && <option value={form.status_on_create}>{form.status_on_create}</option>}
                  {statuses.map(status => <option key={status.name} value={status.name}>{status.label}</option>)}
                </select>
                <ErrorText message={validation.status_on_create} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Priority</label>
                <select className={fieldClass()} value={form.priority} onChange={e => onChange({ ...form, priority: e.target.value as SeriesForm['priority'] })}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Story Points</label>
                <input type="number" min={0} step={1} className={fieldClass()} value={form.story_points} onChange={e => onChange({ ...form, story_points: Number(e.target.value) })} />
              </div>
            </div>
          </section>

          <section className="space-y-3 border-t border-slate-800 pt-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <CalendarClock className="h-3.5 w-3.5 text-amber-400" />
              Schedule
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Frequency</label>
                <select className={fieldClass()} value={form.schedule_kind} onChange={e => onChange({ ...form, schedule_kind: e.target.value as SeriesForm['schedule_kind'] })}>
                  <option value="minutes">Every N minutes</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="custom">Custom expression</option>
                </select>
              </div>
              <div className={form.schedule_kind === 'minutes' ? '' : 'hidden'}>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Interval *</label>
                <input
                  type="number"
                  min={MINUTE_INTERVAL_MIN}
                  max={MINUTE_INTERVAL_MAX}
                  step={1}
                  className={fieldClass(Boolean(validation.minute_interval))}
                  value={form.minute_interval}
                  onChange={e => onChange({ ...form, minute_interval: e.target.value === '' ? '' : Number(e.target.value) })}
                  disabled={form.schedule_kind !== 'minutes'}
                />
                <ErrorText message={validation.minute_interval} />
                {form.schedule_kind === 'minutes' && <p className="mt-1 text-[11px] text-slate-500">Supported range: {MINUTE_INTERVAL_MIN}-{MINUTE_INTERVAL_MAX} minutes.</p>}
              </div>
              <div className={form.schedule_kind === 'weekly' ? '' : 'hidden'}>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Day</label>
                <select className={fieldClass()} value={form.weekday} onChange={e => onChange({ ...form, weekday: e.target.value })} disabled={form.schedule_kind !== 'weekly'}>
                  {WEEKDAYS.map(day => <option key={day} value={day}>{day[0].toUpperCase() + day.slice(1)}</option>)}
                </select>
              </div>
              <div className={form.schedule_kind === 'daily' || form.schedule_kind === 'weekly' ? '' : 'hidden'}>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Time *</label>
                <input type="time" className={fieldClass(Boolean(validation.schedule_time))} value={form.schedule_time} onChange={e => onChange({ ...form, schedule_time: e.target.value })} />
                <ErrorText message={validation.schedule_time} />
              </div>
            </div>
            {form.schedule_kind === 'custom' && (
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Custom Schedule *</label>
                <input className={fieldClass(Boolean(validation.custom_schedule))} value={form.custom_schedule} onChange={e => onChange({ ...form, custom_schedule: e.target.value })} placeholder="Existing cron or custom expression" />
                <ErrorText message={validation.custom_schedule} />
                <p className="mt-1 text-[11px] text-slate-500">Use this only for existing schedules that already rely on backend-supported custom syntax.</p>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Timezone *</label>
                <input className={fieldClass(Boolean(validation.timezone))} value={form.timezone} onChange={e => onChange({ ...form, timezone: e.target.value })} placeholder="America/New_York" />
                <ErrorText message={validation.timezone} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Overlap Policy</label>
                <select className={fieldClass()} value={form.overlap_policy} onChange={e => onChange({ ...form, overlap_policy: e.target.value as RecurringTaskOverlapPolicy })}>
                  <option value="skip_if_active">Skip when an active generated task exists</option>
                  <option value="create_anyway">Create every occurrence</option>
                </select>
              </div>
            </div>
          </section>

          <section className="space-y-3 border-t border-slate-800 pt-5">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Optional Agent Pin</label>
              <select className={fieldClass()} value={form.agent_id} onChange={e => onChange({ ...form, agent_id: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">Use normal task routing</option>
                {projectAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">Leave blank unless this series must preassign generated tasks. Workflow routing still controls dispatch.</p>
            </div>
            <label className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2">
              <span>
                <span className="block text-sm font-medium text-white">Enabled</span>
                <span className="block text-xs text-slate-400">Disabled series keep history and stop creating scheduled tasks.</span>
              </span>
              <input type="checkbox" checked={form.enabled} onChange={e => onChange({ ...form, enabled: e.target.checked })} className="h-4 w-4 accent-amber-500" />
            </label>
          </section>
        </div>

        <div className="border-t border-slate-700 px-4 py-3 sm:px-6">
          {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
            <button type="button" onClick={onSave} disabled={saving || Object.values(validation).some(Boolean)} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-400 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save Series'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryDrawer({ series, runs, loading, onClose }: { series: RecurringTaskSeries; runs: RecurringTaskRun[]; loading: boolean; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 sm:flex sm:justify-end" onClick={onClose}>
      <aside className="ml-auto flex h-full w-full max-w-xl flex-col border-l border-slate-700 bg-slate-900 shadow-2xl" onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-700 px-4 py-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Run History</p>
            <h2 className="truncate text-base font-semibold text-white">{series.title_template}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:text-white" aria-label="Close run history">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="py-8 text-center text-sm text-slate-500">Loading history...</div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4 text-sm text-slate-400">No scheduler attempts recorded yet.</div>
          ) : (
            <div className="space-y-3">
              {runs.map(run => (
                <div key={run.id} className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={badgeClass(runTone(run.status))}>{run.status}</span>
                    <span className="text-xs text-slate-500">{formatDateTime(run.scheduled_for)}</span>
                  </div>
                  {run.generated_task && (
                    <Link href={`/tasks/${run.generated_task.id}`} className="mt-2 inline-flex items-center gap-1 text-sm text-amber-300 hover:text-amber-200">
                      #{run.generated_task.id} {run.generated_task.title ?? 'Generated task'} <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                  {run.error_message && <p className="mt-2 text-xs text-red-300">{run.error_message}</p>}
                  <p className="mt-2 text-[11px] text-slate-500">Started {run.started_at ? timeAgo(run.started_at) : 'unknown'}{run.finished_at ? `, finished ${timeAgo(run.finished_at)}` : ''}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function RecurringTasksPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [series, setSeries] = useState<RecurringTaskSeries[]>([]);
  const defaultProjectId = useMemo(() => projects.find(project => Boolean(project.is_default))?.id ?? projects[0]?.id ?? null, [projects]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProject, setSelectedProject] = useProjectFilterPreference({
    fallbackProjectId: defaultProjectId,
    validProjectIds,
  });
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalForm, setModalForm] = useState<SeriesForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [historySeries, setHistorySeries] = useState<RecurringTaskSeries | null>(null);
  const [historyRuns, setHistoryRuns] = useState<RecurringTaskRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const loadSeries = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getRecurringTaskSeries({
      project_id: selectedProject,
      enabled: enabledFilter === 'all' ? null : enabledFilter === 'enabled',
      limit: 200,
    })
      .then(response => setSeries(response.series))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load recurring task series'))
      .finally(() => setLoading(false));
  }, [enabledFilter, selectedProject]);

  useEffect(() => {
    Promise.all([api.getProjects(), api.getSprints(undefined, true), api.getAgents()])
      .then(([projectList, sprintList, agentList]) => {
        setProjects(projectList);
        setSprints(sprintList);
        setAgents(agentList);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load recurring task inputs'));
  }, []);

  useEffect(() => {
    loadSeries();
  }, [loadSeries]);

  const projectSprints = useMemo(() => selectedProject ? sprints.filter(sprint => sprint.project_id === selectedProject) : sprints, [selectedProject, sprints]);

  const saveSeries = async () => {
    if (!modalForm) return;
    setSaving(true);
    setFormError(null);
    const payload: RecurringTaskSeriesInput = {
      project_id: Number(modalForm.project_id),
      workflow_id: Number(modalForm.sprint_id),
      title_template: modalForm.title_template.trim(),
      description_template: modalForm.description_template,
      task_type: modalForm.task_type,
      priority: modalForm.priority,
      story_points: Number(modalForm.story_points),
      status_on_create: modalForm.status_on_create,
      schedule_expression: buildScheduleExpression(modalForm),
      timezone: modalForm.timezone.trim(),
      enabled: modalForm.enabled,
      overlap_policy: modalForm.overlap_policy,
      agent_id: modalForm.agent_id === '' ? null : Number(modalForm.agent_id),
      changed_by: 'User',
    };
    try {
      if (modalForm.id) await api.updateRecurringTaskSeries(modalForm.id, payload);
      else await api.createRecurringTaskSeries(payload);
      setModalForm(null);
      loadSeries();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (item: RecurringTaskSeries) => {
    const enable = !Boolean(item.enabled);
    if (!enable && !window.confirm(`Disable "${item.title_template}"? Scheduled tasks will stop until it is re-enabled.`)) return;
    setBusyId(item.id);
    try {
      if (enable) await api.enableRecurringTaskSeries(item.id);
      else await api.disableRecurringTaskSeries(item.id);
      loadSeries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status update failed');
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (item: RecurringTaskSeries) => {
    if (!window.confirm(`Run "${item.title_template}" now? This creates a normal task in the fixed workflow.`)) return;
    setBusyId(item.id);
    try {
      const result = await api.runRecurringTaskSeriesNow(item.id);
      loadSeries();
      if (result.task?.id && window.confirm(`Created task #${result.task.id}. Open it now?`)) {
        window.location.href = `/tasks/${result.task.id}`;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run now failed');
    } finally {
      setBusyId(null);
    }
  };

  const openHistory = (item: RecurringTaskSeries) => {
    setHistorySeries(item);
    setHistoryRuns([]);
    setHistoryLoading(true);
    api.getRecurringTaskSeriesHistory(item.id, 25)
      .then(response => setHistoryRuns(response.runs))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load run history'))
      .finally(() => setHistoryLoading(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-slate-950 p-3 md:p-6" data-tour-target="recurring-tasks-main">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-white">Recurring Tasks</h1>
            <span className={badgeClass('cyan')}>{series.length} shown</span>
          </div>
          <p className="mt-1 text-sm text-slate-400">Fixed-workflow schedules that create tasks. They do not launch agents directly.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/tasks" className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:border-slate-400 hover:text-white">Task Board</Link>
          <button type="button" onClick={() => setModalForm(emptyForm(selectedProject))} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-black hover:bg-amber-400">
            <Plus className="h-4 w-4" />
            New Series
          </button>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-[minmax(220px,320px)_180px_auto]">
        <div className="relative">
          <select className={fieldClass()} value={selectedProject ?? ''} onChange={e => setSelectedProject(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All projects</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
        </div>
        <select className={fieldClass()} value={enabledFilter} onChange={e => setEnabledFilter(e.target.value as typeof enabledFilter)}>
          <option value="all">All states</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <button type="button" onClick={loadSeries} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:border-slate-400 hover:text-white md:justify-self-start">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="min-h-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
        <div className="hidden min-w-[1120px] grid-cols-[1.7fr_1fr_0.9fr_0.85fr_1.05fr_0.9fr_0.9fr_0.9fr_1fr] gap-3 border-b border-slate-800 bg-slate-950/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 lg:grid">
          <div>Series</div>
          <div>Project / Workflow</div>
          <div>Task Type</div>
          <div>Schedule</div>
          <div>Status</div>
          <div>Next Run</div>
          <div>Last Run</div>
          <div>Recent Task</div>
          <div>Actions</div>
        </div>
        <div className="overflow-x-auto">
          {loading ? (
            <div className="py-10 text-center text-sm text-slate-500">Loading recurring task series...</div>
          ) : series.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">No recurring task series match these filters.</div>
          ) : (
            <div className="min-w-full divide-y divide-slate-800 lg:min-w-[1120px]">
              {series.map(item => (
                <div key={item.id} className="grid gap-3 px-4 py-4 lg:grid-cols-[1.7fr_1fr_0.9fr_0.85fr_1.05fr_0.9fr_0.9fr_0.9fr_1fr] lg:items-center">
                  <div className="min-w-0">
                    <button type="button" onClick={() => setModalForm(formFromSeries(item))} className="block max-w-full truncate text-left text-sm font-semibold text-white hover:text-amber-300">
                      {item.title_template}
                    </button>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className={badgeClass(Boolean(item.enabled) ? 'green' : 'slate')}>{Boolean(item.enabled) ? 'enabled' : 'disabled'}</span>
                      <span className={badgeClass('slate')}>{item.overlap_policy}</span>
                      {item.agent_name && <span className={badgeClass('amber')}>Pinned: {item.agent_name}</span>}
                    </div>
                  </div>
                  <div className="min-w-0 text-sm text-slate-300">
                    <div className="truncate">{item.project_name ?? `Project #${item.project_id}`}</div>
                    <div className="truncate text-xs text-slate-500">{item.sprint_name ?? `Workflow #${item.sprint_id}`} {item.sprint_status ? `(${item.sprint_status})` : ''}</div>
                  </div>
                  <div className="text-sm text-slate-300">{item.task_type}</div>
                  <div className="text-sm text-slate-300">
                    <div>{formatScheduleExpression(item.schedule_expression ?? item.schedule)}</div>
                    <div className="text-xs text-slate-500">{item.timezone}</div>
                  </div>
                  <div className="space-y-1 text-sm">
                    <div className="text-slate-300">{item.status_on_create}</div>
                    <div className="text-xs text-slate-500">{item.priority} / {item.story_points} pts</div>
                  </div>
                  <div className="text-sm text-slate-300">{item.next_run_at ? <><div>{relativeTimeLabel(item.next_run_at)}</div><div className="text-xs text-slate-500">{formatDateTime(item.next_run_at)}</div></> : '-'}</div>
                  <div className="text-sm text-slate-300">{item.last_run_at ? <><div>{timeAgo(item.last_run_at)}</div><div className="text-xs text-slate-500">{formatDateTime(item.last_run_at)}</div></> : '-'}</div>
                  <div className="text-sm">
                    {item.latest_run_status ? <span className={badgeClass(runTone(item.latest_run_status))}>{item.latest_run_status}</span> : <span className="text-slate-500">No runs</span>}
                    <div className="mt-1 text-xs text-slate-500">{item.generated_task_count ?? 0} generated</div>
                    {item.latest_run_created_task_id && (
                      <Link href={`/tasks/${item.latest_run_created_task_id}`} className="mt-1 flex items-center gap-1 text-xs text-amber-300 hover:text-amber-200">
                        Task #{item.latest_run_created_task_id}
                      </Link>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button type="button" onClick={() => toggleEnabled(item)} disabled={busyId === item.id} className="rounded-md border border-slate-600 p-2 text-slate-300 hover:border-slate-400 hover:text-white" title={Boolean(item.enabled) ? 'Disable series' : 'Enable series'}>
                      {Boolean(item.enabled) ? <Pause className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                    </button>
                    <button type="button" onClick={() => runNow(item)} disabled={busyId === item.id} className="rounded-md border border-slate-600 p-2 text-slate-300 hover:border-amber-400 hover:text-amber-300" title="Run now">
                      <Play className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => openHistory(item)} className="rounded-md border border-slate-600 p-2 text-slate-300 hover:border-slate-400 hover:text-white" title="Run history">
                      <History className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => setModalForm(formFromSeries(item))} className="rounded-md border border-slate-600 p-2 text-slate-300 hover:border-slate-400 hover:text-white" title="Edit series">
                      <Settings2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {projectSprints.length === 0 && !loading && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <Zap className="mt-0.5 h-4 w-4 shrink-0" />
          Create an active or planning workflow before adding a recurring series. V1 requires a fixed workflow.
        </div>
      )}

      {modalForm && (
        <SeriesModal
          form={modalForm}
          projects={projects}
          sprints={sprints}
          agents={agents}
          saving={saving}
          error={formError}
          onChange={setModalForm}
          onClose={() => setModalForm(null)}
          onSave={saveSeries}
        />
      )}

      {historySeries && (
        <HistoryDrawer
          series={historySeries}
          runs={historyRuns}
          loading={historyLoading}
          onClose={() => setHistorySeries(null)}
        />
      )}
    </div>
  );
}
