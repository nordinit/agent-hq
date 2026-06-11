'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { TaskRelationshipTypeConfig } from '@/lib/api';
import { TableColumnFilter, matchesColumnFilter, uniqueColumnOptions } from '@/components/TableColumnFilter';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import { TABLE_DELETE_ACTION_CLASS, TABLE_EDIT_ACTION_CLASS } from '@/components/workflowConfig';
import { AlertTriangle, Pencil, Trash2 } from 'lucide-react';
import { RELATIONSHIP_COLUMN_HELP } from '../workflowDefinitionShared';

export function RelationshipTypesTable({
  relationshipTypes,
  emptyMessage,
  editorPanel,
  editingRelationshipTypeId,
  addingRelationshipType,
  onEdit,
  onDelete,
  saving,
}: {
  relationshipTypes: TaskRelationshipTypeConfig[];
  emptyMessage: string;
  editorPanel: ReactNode;
  editingRelationshipTypeId: number | null;
  addingRelationshipType: boolean;
  onEdit: (relationshipType: TaskRelationshipTypeConfig) => void;
  onDelete: (relationshipType: TaskRelationshipTypeConfig) => void;
  saving: string | null;
}) {
  const sortedTypes = useMemo(() => relationshipTypes.slice().sort((a, b) => a.key.localeCompare(b.key)), [relationshipTypes]);
  const [filterKeys, setFilterKeys] = useState<string[]>([]);
  const [filterLabels, setFilterLabels] = useState<string[]>([]);
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterDirections, setFilterDirections] = useState<string[]>([]);
  const [filterDispatch, setFilterDispatch] = useState<string[]>([]);
  const [filterCreateRelated, setFilterCreateRelated] = useState<string[]>([]);
  const keyOptions = useMemo(() => relationshipTypes.map(type => ({ value: type.key, label: type.key })), [relationshipTypes]);
  const labelOptions = useMemo(() => uniqueColumnOptions(
    relationshipTypes.flatMap(type => [
      { value: type.label, label: type.label },
      { value: type.inverse_label || '__not_set__', label: type.inverse_label || 'Inverse not set' },
    ]),
  ), [relationshipTypes]);
  const categoryOptions = useMemo(() => relationshipTypes.map(type => ({ value: type.category || 'general', label: type.category || 'general' })), [relationshipTypes]);
  const directionOptions = useMemo(() => relationshipTypes.map(type => ({ value: type.direction_semantics, label: type.direction_semantics })), [relationshipTypes]);
  const dispatchOptions = useMemo(() => uniqueColumnOptions(
    relationshipTypes.flatMap(type => {
      if (type.affects_dispatch_eligibility !== 1) return [{ value: 'informational', label: 'informational' }];
      return [
        { value: 'affects dispatch', label: 'affects dispatch' },
        ...((type.active_statuses ?? []).length > 0 ? type.active_statuses ?? [] : ['all non-resolved statuses']).map(status => ({ value: `active:${status}`, label: `Active: ${status}` })),
        ...((type.resolved_statuses ?? []).length > 0 ? type.resolved_statuses ?? [] : ['none configured']).map(status => ({ value: `resolved:${status}`, label: `Resolved: ${status}` })),
      ];
    }),
  ), [relationshipTypes]);
  const createRelatedOptions = useMemo(() => uniqueColumnOptions(
    relationshipTypes.map(type => type.allow_create_related_task === 1
      ? { value: 'enabled', label: 'enabled' }
      : { value: 'not enabled', label: 'not enabled' }),
  ), [relationshipTypes]);
  const filteredTypes = useMemo(() => sortedTypes.filter(type => {
    const labels = [type.label, type.inverse_label || '__not_set__'];
    const dispatchValues = type.affects_dispatch_eligibility === 1
      ? [
        'affects dispatch',
        ...((type.active_statuses ?? []).length > 0 ? type.active_statuses ?? [] : ['all non-resolved statuses']).map(status => `active:${status}`),
        ...((type.resolved_statuses ?? []).length > 0 ? type.resolved_statuses ?? [] : ['none configured']).map(status => `resolved:${status}`),
      ]
      : ['informational'];
    const createRelatedValue = type.allow_create_related_task === 1 ? 'enabled' : 'not enabled';
    return matchesColumnFilter(filterKeys, type.key)
      && labels.some(value => matchesColumnFilter(filterLabels, value))
      && matchesColumnFilter(filterCategories, type.category || 'general')
      && matchesColumnFilter(filterDirections, type.direction_semantics)
      && dispatchValues.some(value => matchesColumnFilter(filterDispatch, value))
      && matchesColumnFilter(filterCreateRelated, createRelatedValue);
  }), [filterCategories, filterCreateRelated, filterDirections, filterDispatch, filterKeys, filterLabels, sortedTypes]);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/60">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700 text-left">
              <th className="px-3 py-2.5"><TableColumnFilter label="Key" description={RELATIONSHIP_COLUMN_HELP.key} selected={filterKeys} onChange={setFilterKeys} options={keyOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Labels" description={RELATIONSHIP_COLUMN_HELP.labels} selected={filterLabels} onChange={setFilterLabels} options={labelOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Category" description={RELATIONSHIP_COLUMN_HELP.category} selected={filterCategories} onChange={setFilterCategories} options={categoryOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Direction" description={RELATIONSHIP_COLUMN_HELP.direction} selected={filterDirections} onChange={setFilterDirections} options={directionOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Dispatch impact" description={RELATIONSHIP_COLUMN_HELP.dispatchImpact} selected={filterDispatch} onChange={setFilterDispatch} options={dispatchOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Create related" description={RELATIONSHIP_COLUMN_HELP.createRelated} selected={filterCreateRelated} onChange={setFilterCreateRelated} options={createRelatedOptions} /></th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-slate-400"><ColumnHeaderLabel label="Actions" description={RELATIONSHIP_COLUMN_HELP.actions} align="right" /></th>
            </tr>
          </thead>
          <tbody>
            {addingRelationshipType && (
              <tr>
                <td colSpan={7} className="p-3">{editorPanel}</td>
              </tr>
            )}
            {sortedTypes.length === 0 && !addingRelationshipType && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-sm text-slate-400">{emptyMessage}</td>
              </tr>
            )}
            {filteredTypes.map(relationshipType => {
              if (editingRelationshipTypeId === relationshipType.id) {
                return (
                  <tr key={`editor-${relationshipType.id}`}>
                    <td colSpan={7} className="p-3">{editorPanel}</td>
                  </tr>
                );
              }
              return (
                <tr key={relationshipType.id} className="border-b border-slate-700/50 transition-colors hover:bg-slate-800/30">
                  <td className="px-3 py-3 align-top">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs text-slate-300">{relationshipType.key}</code>
                      {relationshipType.is_system === 1 && <span className="rounded-full border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">starter</span>}
                    </div>
                  </td>
                  <td className="max-w-[260px] px-3 py-3 align-top">
                    <p className="text-xs font-medium text-slate-200">{relationshipType.label}</p>
                    <p className="mt-1 text-xs text-slate-500">Inverse: {relationshipType.inverse_label || 'Not set'}</p>
                  </td>
                  <td className="px-3 py-3 align-top"><span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-300">{relationshipType.category || 'general'}</span></td>
                  <td className="px-3 py-3 align-top"><span className="font-mono text-[11px] text-slate-400">{relationshipType.direction_semantics}</span></td>
                  <td className="px-3 py-3 align-top">
                    {relationshipType.affects_dispatch_eligibility === 1 ? (
                      <div className="space-y-1">
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300"><AlertTriangle className="h-3 w-3" /> affects dispatch</span>
                        <p className="text-[11px] text-slate-500">Active: {(relationshipType.active_statuses ?? []).join(', ') || 'all non-resolved statuses'}</p>
                        <p className="text-[11px] text-slate-500">Resolved: {(relationshipType.resolved_statuses ?? []).join(', ') || 'none configured'}</p>
                      </div>
                    ) : <span className="text-xs text-slate-600">informational</span>}
                  </td>
                  <td className="px-3 py-3 align-top text-xs text-slate-400">
                    {relationshipType.allow_create_related_task === 1 ? (
                      <span className="inline-flex rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">enabled</span>
                    ) : <span className="text-slate-600">not enabled</span>}
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    <div className="flex justify-end gap-1">
                      <button type="button" onClick={() => onEdit(relationshipType)} className={TABLE_EDIT_ACTION_CLASS} title="Edit relationship type"><Pencil className="h-3.5 w-3.5" /></button>
                      <button type="button" disabled={saving === `delete-relationship-type-${relationshipType.id}`} onClick={() => onDelete(relationshipType)} className={TABLE_DELETE_ACTION_CLASS} title="Delete relationship type"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredTypes.length === 0 && sortedTypes.length > 0 && !addingRelationshipType && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-sm text-slate-400">No relationship types match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
