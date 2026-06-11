import type { TaskStatusMeta } from '@/lib/api';

export type TaskStatusColor = 'slate' | 'cyan' | 'violet' | 'amber' | 'blue' | 'emerald' | 'fuchsia' | 'teal' | 'green' | 'red' | 'orange' | 'yellow' | 'purple' | 'indigo';

export interface TaskStatusDefinition {
  key: string;
  label: string;
  color: TaskStatusColor;
  badgeClass: string;
  dotClass: string;
}

const COLOR_STYLES: Record<TaskStatusColor, { badgeClass: string; dotClass: string }> = {
  slate: { badgeClass: 'bg-slate-700 text-slate-300', dotClass: 'bg-slate-400' },
  cyan: { badgeClass: 'bg-cyan-900/60 text-cyan-300', dotClass: 'bg-cyan-400' },
  violet: { badgeClass: 'bg-violet-900/60 text-violet-300', dotClass: 'bg-violet-400' },
  amber: { badgeClass: 'bg-amber-900/60 text-amber-300', dotClass: 'bg-amber-400' },
  blue: { badgeClass: 'bg-blue-900/60 text-blue-300', dotClass: 'bg-blue-400' },
  emerald: { badgeClass: 'bg-emerald-900/60 text-emerald-300', dotClass: 'bg-emerald-400' },
  fuchsia: { badgeClass: 'bg-fuchsia-900/60 text-fuchsia-300', dotClass: 'bg-fuchsia-400' },
  teal: { badgeClass: 'bg-teal-900/60 text-teal-300', dotClass: 'bg-teal-400' },
  green: { badgeClass: 'bg-green-900/60 text-green-300', dotClass: 'bg-green-400' },
  red: { badgeClass: 'bg-red-900/60 text-red-300', dotClass: 'bg-red-400' },
  orange: { badgeClass: 'bg-orange-900/60 text-orange-300', dotClass: 'bg-orange-400' },
  yellow: { badgeClass: 'bg-yellow-900/60 text-yellow-300', dotClass: 'bg-yellow-400' },
  purple: { badgeClass: 'bg-purple-900/60 text-purple-300', dotClass: 'bg-purple-400' },
  indigo: { badgeClass: 'bg-indigo-900/60 text-indigo-300', dotClass: 'bg-indigo-400' },
};

function toUiColor(color?: string): TaskStatusColor {
  const normalized = (color || 'slate').toLowerCase();
  if (normalized in COLOR_STYLES) return normalized as TaskStatusColor;
  return 'slate';
}

export function normalizeTaskStatuses(statuses?: TaskStatusMeta[] | null): TaskStatusDefinition[] {
  return (statuses ?? [])
    .map((status, index) => {
      const color = toUiColor(status.color);
      return {
        key: status.name,
        label: status.label || status.name,
        color,
        badgeClass: COLOR_STYLES[color].badgeClass,
        dotClass: COLOR_STYLES[color].dotClass,
        stage_order: typeof status.stage_order === 'number' ? status.stage_order : index,
      };
    })
    .sort((a, b) => a.stage_order - b.stage_order || a.label.localeCompare(b.label))
    .map(({ stage_order: _stageOrder, ...status }) => status);
}

export function getTaskStatusMaps(statuses?: TaskStatusMeta[] | null) {
  const normalized = normalizeTaskStatuses(statuses);
  return {
    definitions: normalized,
    labels: Object.fromEntries(normalized.map(status => [status.key, status.label])) as Record<string, string>,
    badges: Object.fromEntries(normalized.map(status => [status.key, status.badgeClass])) as Record<string, string>,
    dots: Object.fromEntries(normalized.map(status => [status.key, status.dotClass])) as Record<string, string>,
  };
}

export function getTaskBoardColumns(statuses?: TaskStatusMeta[] | null) {
  return normalizeTaskStatuses(statuses).map(({ key, label, color }) => ({ key, label, color }));
}

export function getDefaultVisibleTaskColumns(statuses?: TaskStatusMeta[] | null) {
  return getTaskBoardColumns(statuses).map(status => status.key);
}

export const TASK_STATUSES: TaskStatusDefinition[] = [];
export const TASK_STATUS_MAP: Record<string, TaskStatusDefinition> = {};
export const TASK_STATUS_LABELS: Record<string, string> = {};
export const TASK_STATUS_BADGES: Record<string, string> = {};
export const TASK_STATUS_DOTS: Record<string, string> = {};
export const TASK_BOARD_COLUMNS: Array<{ key: string; label: string; color: string }> = [];
export const DEFAULT_VISIBLE_TASK_COLUMNS: string[] = [];
