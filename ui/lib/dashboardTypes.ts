import type { TelemetryDisplay, TelemetryResource, TelemetryScope, TelemetryWidget } from './telemetryTypes';

export type DashboardAccent = 'blue' | 'amber' | 'green' | 'cyan' | 'violet' | 'red' | 'neutral';
export type DashboardIcon = 'activity' | 'bot' | 'search' | 'users' | 'target' | 'check' | 'coins' | 'file' | 'layers' | 'clock';
export type DashboardOperation = 'agents' | 'active_runs' | 'templates' | 'runs' | 'completed_runs' | 'tokens' | 'failed_runs' | 'failures' | 'completed_tasks' | 'links';
interface BlockAppearance { id: string; title?: string; accent?: DashboardAccent; icon?: DashboardIcon; surface?: 'card' | 'plain' }
export type DashboardBlock = BlockAppearance & (
  { type: 'metric'; binding_id: string; display?: TelemetryDisplay; precision?: number } |
  { type: 'comparison'; binding_ids: string[]; rows?: number; sort?: 'label' | 'value_desc' | 'value_asc'; sort_by?: string } |
  { type: 'operation'; operation: DashboardOperation } |
  { type: 'heading' | 'note' | 'callout'; text: string } |
  { type: 'divider' } |
  { type: 'link'; url: string }
);
export interface DashboardColumn { id: string; width: number; blocks: DashboardBlock[] }
export interface DashboardSection { id: string; title: string; collapsed?: boolean; columns: DashboardColumn[] }
export interface DashboardDocument {
  version: 1;
  description?: string;
  template?: 'operations' | 'agency' | 'blank' | 'imported';
  scope?: TelemetryScope;
  from?: string;
  to?: string;
  timezone: string;
  appearance: { width: 'standard' | 'wide'; density: 'comfortable' | 'compact' };
  metrics: (TelemetryWidget & { id: string })[];
  sections: DashboardSection[];
}
export type SavedDashboard = TelemetryResource<DashboardDocument>;
export interface DashboardDraft { name: string; definition: DashboardDocument }
