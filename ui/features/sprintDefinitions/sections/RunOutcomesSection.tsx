'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { SprintTypeOutcome } from '@/lib/api';
import { getBadgeVariantClass } from '@/lib/badgeVariants';
import { TableColumnFilter, matchesColumnFilter } from '@/components/TableColumnFilter';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import { TABLE_DELETE_ACTION_CLASS, TABLE_EDIT_ACTION_CLASS } from '@/components/workflowConfig';
import { Pencil, Trash2 } from 'lucide-react';
import { OUTCOME_COLUMN_HELP } from '../workflowDefinitionShared';

export function RunOutcomesTable({
  outcomes,
  emptyMessage,
  editorPanel,
  editingOutcomeId,
  addingOutcome,
  onEdit,
  onDelete,
  saving,
}: {
  outcomes: SprintTypeOutcome[];
  emptyMessage: string;
  editorPanel: ReactNode;
  editingOutcomeId: number | null;
  addingOutcome: boolean;
  onEdit: (outcome: SprintTypeOutcome) => void;
  onDelete: (outcome: SprintTypeOutcome) => void;
  saving: string | null;
}) {
  const [filterScopes, setFilterScopes] = useState<string[]>([]);
  const [filterCodes, setFilterCodes] = useState<string[]>([]);
  const [filterNames, setFilterNames] = useState<string[]>([]);
  const [filterBehaviors, setFilterBehaviors] = useState<string[]>([]);
  const [filterBadges, setFilterBadges] = useState<string[]>([]);
  const [filterMetadata, setFilterMetadata] = useState<string[]>([]);
  const [filterEnabled, setFilterEnabled] = useState<string[]>([]);
  const scopeForOutcome = (outcome: SprintTypeOutcome) => outcome.task_type ?? 'base';
  const metadataForOutcome = (outcome: SprintTypeOutcome) => {
    if (outcome.metadata?.failure_like === true) return 'failure like';
    if (outcome.metadata?.blocked_like === true) return 'blocked like';
    return 'none';
  };
  const scopeOptions = useMemo(() => outcomes.map(outcome => ({ value: scopeForOutcome(outcome), label: scopeForOutcome(outcome) })), [outcomes]);
  const codeOptions = useMemo(() => outcomes.map(outcome => ({ value: outcome.outcome_key, label: outcome.outcome_key })), [outcomes]);
  const nameOptions = useMemo(() => outcomes.map(outcome => ({ value: outcome.label, label: outcome.label })), [outcomes]);
  const behaviorOptions = useMemo(() => outcomes.map(outcome => ({ value: outcome.behavior, label: outcome.behavior })), [outcomes]);
  const badgeOptions = useMemo(() => outcomes.map(outcome => ({ value: outcome.badge_variant || 'workspace', label: outcome.badge_variant || 'workspace' })), [outcomes]);
  const metadataOptions = useMemo(() => outcomes.map(outcome => ({ value: metadataForOutcome(outcome), label: metadataForOutcome(outcome) })), [outcomes]);
  const enabledOptions = useMemo(() => ([
    { value: 'yes', label: 'yes' },
    { value: 'no', label: 'no' },
  ]), []);
  const filteredOutcomes = useMemo(() => outcomes.filter(outcome => (
    matchesColumnFilter(filterScopes, scopeForOutcome(outcome))
    && matchesColumnFilter(filterCodes, outcome.outcome_key)
    && matchesColumnFilter(filterNames, outcome.label)
    && matchesColumnFilter(filterBehaviors, outcome.behavior)
    && matchesColumnFilter(filterBadges, outcome.badge_variant || 'workspace')
    && matchesColumnFilter(filterMetadata, metadataForOutcome(outcome))
    && matchesColumnFilter(filterEnabled, outcome.enabled === 1 ? 'yes' : 'no')
  )), [filterBadges, filterBehaviors, filterCodes, filterEnabled, filterMetadata, filterNames, filterScopes, outcomes]);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/60">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700 text-left">
              <th className="px-3 py-2.5"><TableColumnFilter label="Scope" description={OUTCOME_COLUMN_HELP.scope} selected={filterScopes} onChange={setFilterScopes} options={scopeOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Outcome Code" description={OUTCOME_COLUMN_HELP.code} selected={filterCodes} onChange={setFilterCodes} options={codeOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Name" description={OUTCOME_COLUMN_HELP.name} selected={filterNames} onChange={setFilterNames} options={nameOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Behavior" description={OUTCOME_COLUMN_HELP.behavior} selected={filterBehaviors} onChange={setFilterBehaviors} options={behaviorOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Badge" description={OUTCOME_COLUMN_HELP.badge} selected={filterBadges} onChange={setFilterBadges} options={badgeOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Metadata" description={OUTCOME_COLUMN_HELP.metadata} selected={filterMetadata} onChange={setFilterMetadata} options={metadataOptions} /></th>
              <th className="px-3 py-2.5 text-center"><TableColumnFilter label="Enabled" description={OUTCOME_COLUMN_HELP.enabled} selected={filterEnabled} onChange={setFilterEnabled} options={enabledOptions} align="center" /></th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-slate-400"><ColumnHeaderLabel label="Actions" description={OUTCOME_COLUMN_HELP.actions} align="right" /></th>
            </tr>
          </thead>
          <tbody>
            {addingOutcome && (
              <tr>
                <td colSpan={8} className="p-3">{editorPanel}</td>
              </tr>
            )}
            {outcomes.length === 0 && !addingOutcome && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-sm text-slate-400">{emptyMessage}</td>
              </tr>
            )}
            {filteredOutcomes.map(outcome => {
              if (editingOutcomeId === outcome.id) {
                return (
                  <tr key={`editor-${outcome.id}`}>
                    <td colSpan={8} className="p-3">{editorPanel}</td>
                  </tr>
                );
              }
              return (
                <tr key={outcome.id} className="border-b border-slate-700/50 transition-colors hover:bg-slate-800/30">
                  <td className="px-3 py-3 align-top">
                    <span className="font-mono text-xs text-amber-300">{outcome.task_type ?? 'base'}</span>
                  </td>
                  <td className="px-3 py-3 align-top"><code className="font-mono text-xs text-slate-300">{outcome.outcome_key}</code></td>
                  <td className="max-w-[260px] px-3 py-3 align-top">
                    <p className="text-xs font-medium text-slate-200">{outcome.label}</p>
                    <p className="mt-1 text-xs text-slate-500">{outcome.description || 'No description yet.'}</p>
                  </td>
                  <td className="px-3 py-3 align-top"><span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-300">{outcome.behavior}</span></td>
                  <td className="px-3 py-3 align-top">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${getBadgeVariantClass(outcome.badge_variant)}`}>{outcome.badge_variant || 'workspace'}</span>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="flex flex-wrap gap-1">
                      {outcome.metadata?.failure_like === true && <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-300">failure like</span>}
                      {outcome.metadata?.blocked_like === true && <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">blocked like</span>}
                      {outcome.metadata?.failure_like !== true && outcome.metadata?.blocked_like !== true && <span className="text-xs text-slate-600">none</span>}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-center align-top">{outcome.enabled === 1 ? <span className="text-xs text-green-400">yes</span> : <span className="text-xs text-slate-600">no</span>}</td>
                  <td className="px-3 py-3 text-right align-top">
                    <div className="flex justify-end gap-1">
                      <button type="button" onClick={() => onEdit(outcome)} className={TABLE_EDIT_ACTION_CLASS} title="Edit run outcome">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" disabled={saving === `delete-outcome-${outcome.id}`} onClick={() => onDelete(outcome)} className={TABLE_DELETE_ACTION_CLASS} title="Delete run outcome">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredOutcomes.length === 0 && outcomes.length > 0 && !addingOutcome && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-sm text-slate-400">No run outcomes match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
