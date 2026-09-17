'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { CustomFieldDefinition, TaskFieldSchema } from '@/lib/api';
import { TableColumnFilter, matchesColumnFilter } from '@/components/TableColumnFilter';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import { TABLE_DELETE_ACTION_CLASS, TABLE_EDIT_ACTION_CLASS } from '@/components/workflowConfig';
import { Pencil, Trash2 } from 'lucide-react';
import { FIELD_COLUMN_HELP, fieldOptionsSummary } from '../workflowDefinitionShared';

export function TaskFieldSchemasTable({
  schemas,
  emptyMessage,
  editorPanel,
  editingDefault,
  editingSchemaId,
  addingTaskTypeSchema,
  onEdit,
  onDelete,
  saving,
}: {
  schemas: TaskFieldSchema[];
  emptyMessage: string;
  editorPanel: ReactNode;
  editingDefault: boolean;
  editingSchemaId: number | null;
  addingTaskTypeSchema: boolean;
  onEdit: (schema: TaskFieldSchema) => void;
  onDelete: (schema: TaskFieldSchema) => void;
  saving: string | null;
}) {
  const [filterScopes, setFilterScopes] = useState<string[]>([]);
  const [filterCodes, setFilterCodes] = useState<string[]>([]);
  const [filterLabels, setFilterLabels] = useState<string[]>([]);
  const [filterTypes, setFilterTypes] = useState<string[]>([]);
  const [filterRequired, setFilterRequired] = useState<string[]>([]);
  const [filterHelp, setFilterHelp] = useState<string[]>([]);

  const scopeForSchema = (schema: TaskFieldSchema) => schema.task_type ?? 'default';
  const allFields = useMemo(() => schemas.flatMap(schema => schema.schema.fields ?? []), [schemas]);
  const scopeOptions = useMemo(() => schemas.map(schema => ({ value: scopeForSchema(schema), label: scopeForSchema(schema) })), [schemas]);
  const codeOptions = useMemo(() => allFields.map(field => ({ value: field.key ?? '', label: field.key ?? '' })).filter(option => option.value), [allFields]);
  const labelOptions = useMemo(() => allFields.map(field => ({ value: field.label || field.key || '', label: field.label || field.key || '' })).filter(option => option.value), [allFields]);
  const typeOptions = useMemo(() => allFields.map(field => ({ value: field.type ?? 'text', label: field.type ?? 'text' })), [allFields]);
  const requiredOptions = useMemo(() => ([
    { value: 'yes', label: 'yes' },
    { value: 'no', label: 'no' },
  ]), []);
  const helpOptions = useMemo(() => allFields.map(field => ({ value: fieldOptionsSummary(field), label: fieldOptionsSummary(field) })), [allFields]);
  const hasFieldFilters = filterCodes.length > 0 || filterLabels.length > 0 || filterTypes.length > 0 || filterRequired.length > 0 || filterHelp.length > 0;
  const filteredSchemaEntries = useMemo(() => schemas
    .map(schema => {
      const scope = scopeForSchema(schema);
      const scopeMatches = matchesColumnFilter(filterScopes, scope);
      const fields = (schema.schema.fields ?? []).filter(field => (
        matchesColumnFilter(filterCodes, field.key ?? '')
        && matchesColumnFilter(filterLabels, field.label || field.key || '')
        && matchesColumnFilter(filterTypes, field.type ?? 'text')
        && matchesColumnFilter(filterRequired, field.required ? 'yes' : 'no')
        && matchesColumnFilter(filterHelp, fieldOptionsSummary(field))
      ));
      return { schema, fields, scopeMatches };
    })
    .filter(entry => entry.scopeMatches && (entry.fields.length > 0 || (!hasFieldFilters && (entry.schema.schema.fields ?? []).length === 0))),
  [filterCodes, filterHelp, filterLabels, filterRequired, filterScopes, filterTypes, hasFieldFilters, schemas]);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/60">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700 text-left">
              <th className="px-3 py-2.5"><TableColumnFilter label="Scope" description={FIELD_COLUMN_HELP.scope} selected={filterScopes} onChange={setFilterScopes} options={scopeOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Field Code" description={FIELD_COLUMN_HELP.code} selected={filterCodes} onChange={setFilterCodes} options={codeOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Label" description={FIELD_COLUMN_HELP.label} selected={filterLabels} onChange={setFilterLabels} options={labelOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Type" description={FIELD_COLUMN_HELP.type} selected={filterTypes} onChange={setFilterTypes} options={typeOptions} /></th>
              <th className="px-3 py-2.5 text-center"><TableColumnFilter label="Required" description={FIELD_COLUMN_HELP.required} selected={filterRequired} onChange={setFilterRequired} options={requiredOptions} align="center" /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Options / Help" description={FIELD_COLUMN_HELP.help} selected={filterHelp} onChange={setFilterHelp} options={helpOptions} /></th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-slate-400"><ColumnHeaderLabel label="Actions" description={FIELD_COLUMN_HELP.actions} align="right" /></th>
            </tr>
          </thead>
          <tbody>
            {addingTaskTypeSchema && (
              <tr>
                <td colSpan={7} className="p-3">{editorPanel}</td>
              </tr>
            )}
            {schemas.length === 0 && !editingDefault && !addingTaskTypeSchema && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-sm text-slate-400">{emptyMessage}</td>
              </tr>
            )}
            {editingDefault && !schemas.some(schema => schema.task_type == null) && (
              <tr>
                <td colSpan={7} className="p-3">{editorPanel}</td>
              </tr>
            )}
            {filteredSchemaEntries.map(({ schema, fields }) => {
              const isDefault = schema.task_type == null;
              const isEditing = (isDefault && editingDefault) || editingSchemaId === schema.id;
              if (isEditing) {
                return (
                  <tr key={`editor-${schema.id}`}>
                    <td colSpan={7} className="p-3">{editorPanel}</td>
                  </tr>
                );
              }

              const rows: Array<CustomFieldDefinition | null> = fields.length > 0 ? fields : [null];
              return rows.map((field, index) => (
                <tr key={`${schema.id}-${field?.key ?? 'empty'}-${index}`} className="border-b border-slate-700/50 transition-colors hover:bg-slate-800/30">
                  {index === 0 && (
                    <td rowSpan={rows.length} className="px-3 py-3 align-top">
                      <div className="flex flex-col gap-1">
                        <span className="font-mono text-xs text-amber-300">{isDefault ? 'default' : schema.task_type}</span>
                        <span className="text-[11px] text-slate-500">{fields.length} field{fields.length === 1 ? '' : 's'}</span>
                      </div>
                    </td>
                  )}
                  {field ? (
                    <>
                      <td className="px-3 py-3 align-top"><code className="font-mono text-xs text-slate-300">{field.key}</code></td>
                      <td className="px-3 py-3 align-top text-xs text-slate-200">{field.label || field.key}</td>
                      <td className="px-3 py-3 align-top"><span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-300">{field.type ?? 'text'}</span></td>
                      <td className="px-3 py-3 text-center align-top">{field.required ? <span className="text-xs text-amber-300">yes</span> : <span className="text-xs text-slate-600">no</span>}</td>
                      <td className="max-w-[360px] px-3 py-3 align-top text-xs text-slate-400">{fieldOptionsSummary(field)}</td>
                    </>
                  ) : (
                    <td colSpan={5} className="px-3 py-3 text-sm text-slate-500">No fields configured for this schema.</td>
                  )}
                  {index === 0 && (
                    <td rowSpan={rows.length} className="px-3 py-3 text-right align-top">
                      <div className="flex justify-end gap-1">
                        <button type="button" onClick={() => onEdit(schema)} className={TABLE_EDIT_ACTION_CLASS} title="Edit task field schema">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" disabled={saving === `delete-schema-${schema.id}`} onClick={() => onDelete(schema)} className={TABLE_DELETE_ACTION_CLASS} title="Delete task field schema">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ));
            })}
            {filteredSchemaEntries.length === 0 && schemas.length > 0 && !editingDefault && !addingTaskTypeSchema && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-sm text-slate-400">No task fields match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

