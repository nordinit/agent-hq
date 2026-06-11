'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type SprintTypeConfig, type SprintTypeOutcome, type TaskFieldSchema, type TaskRelationshipTypeConfig, type TaskStatusMeta } from '@/lib/api';
import { OUTCOME_BADGE_VARIANTS } from '@/lib/badgeVariants';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SectionHeader, SCOPE_CARD_CLASS } from '@/components/workflowConfig';
import { AlertTriangle, ChevronDown, Plus, Save, Trash2, Workflow, X } from 'lucide-react';
import { TaskStatusesTable } from './sections/TaskStatusesSection';
import { TaskFieldSchemasTable } from './sections/TaskFieldsSection';
import { RelationshipTypesTable } from './sections/RelationshipTypesSection';
import { RunOutcomesTable } from './sections/RunOutcomesSection';
import {
  BACKEND_ONLY_OUTCOMES,
  TAB_HELP,
  emptyField,
  emptyOutcomeForm,
  emptyRelationshipTypeForm,
  emptySchemaForm,
  emptySprintTypeForm,
  outcomeToForm,
  relationshipTypeToForm,
  schemaToForm,
  splitListInput,
  type FieldSchemaForm,
  type Notice,
  type OutcomeEditorPlacement,
  type OutcomeForm,
  type RelationshipTypeForm,
  type SchemaDeleteDialogState,
  type SchemaEditorPlacement,
  type SprintDefinitionTab,
  type SprintTypeForm,
} from './workflowDefinitionShared';

export default function SprintDefinitionsPage() {
  const [config, setConfig] = useState<SprintTypeConfig[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [activeTab, setActiveTab] = useState<SprintDefinitionTab>('overview');
  const [creatingSprintType, setCreatingSprintType] = useState(false);
  const [sprintTypeForm, setSprintTypeForm] = useState<SprintTypeForm>(emptySprintTypeForm);
  const [taskTypesText, setTaskTypesText] = useState('');
  const [schemaEditor, setSchemaEditor] = useState<FieldSchemaForm | null>(null);
  const [schemaEditorPlacement, setSchemaEditorPlacement] = useState<SchemaEditorPlacement | null>(null);
  const [outcomeEditor, setOutcomeEditor] = useState<OutcomeForm | null>(null);
  const [outcomeEditorPlacement, setOutcomeEditorPlacement] = useState<OutcomeEditorPlacement | null>(null);
  const [relationshipTypeEditor, setRelationshipTypeEditor] = useState<RelationshipTypeForm | null>(null);
  const [workflowStatuses, setWorkflowStatuses] = useState<TaskStatusMeta[]>([]);
  const [statusLoading, setStatusLoading] = useState(false);
  const [showNewStatus, setShowNewStatus] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [schemaDeleteDialog, setSchemaDeleteDialog] = useState<SchemaDeleteDialogState | null>(null);
  const [schemaDeleteConfirmation, setSchemaDeleteConfirmation] = useState('');

  const load = async (preferredKey?: string) => {
    setLoading(true);
    try {
      const response = await api.getWorkflowConfig();
      const sprintTypes = response.sprint_types ?? [];
      setConfig(sprintTypes);
      const nextKey = preferredKey && sprintTypes.some(type => type.key === preferredKey)
        ? preferredKey
        : sprintTypes[0]?.key ?? '';
      setSelectedKey(nextKey);
      setNotice(null);
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selectedSprintType = useMemo(
    () => config.find(type => type.key === selectedKey) ?? null,
    [config, selectedKey],
  );

  const sprintTypeDeletionState = useMemo(() => {
    if (!selectedSprintType) return null;
    return selectedSprintType.deletion ?? {
      protected: selectedSprintType.key === 'generic',
      reason: selectedSprintType.key === 'generic' ? 'generic' : null,
      open_sprint_count: 0,
      total_sprint_count: 0,
    };
  }, [selectedSprintType]);

  useEffect(() => {
    if (!selectedSprintType) return;
    setWorkflowStatuses((selectedSprintType.statuses ?? []).slice().sort((a, b) => (a.stage_order ?? 0) - (b.stage_order ?? 0)));
    setSprintTypeForm({
      key: selectedSprintType.key,
      name: selectedSprintType.name,
      description: selectedSprintType.description,
    });
    setTaskTypesText(selectedSprintType.task_types.map(taskType => taskType.task_type).join('\n'));
    setCreatingSprintType(false);
    setSchemaEditor(null);
    setSchemaEditorPlacement(null);
    setOutcomeEditor(null);
    setOutcomeEditorPlacement(null);
    setRelationshipTypeEditor(null);
    setShowNewStatus(false);
  }, [selectedSprintType]);

  const reloadStatuses = async (sprintTypeKey: string) => {
    setStatusLoading(true);
    try {
      const response = await api.getSprintTypeStatuses(sprintTypeKey);
      setWorkflowStatuses((response.statuses ?? []).slice().sort((a, b) => (a.stage_order ?? 0) - (b.stage_order ?? 0)));
    } catch (error) {
      setWorkflowStatuses([]);
      setNotice({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedSprintType) {
      setWorkflowStatuses([]);
      return;
    }
    let cancelled = false;
    setStatusLoading(true);
    api.getSprintTypeStatuses(selectedSprintType.key)
      .then(response => {
        if (!cancelled) {
          setWorkflowStatuses((response.statuses ?? []).slice().sort((a, b) => (a.stage_order ?? 0) - (b.stage_order ?? 0)));
        }
      })
      .catch(error => {
        if (!cancelled) {
          setWorkflowStatuses([]);
          setNotice({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedSprintType]);

  const baseFieldSchema = useMemo(
    () => selectedSprintType?.field_schemas.find(schema => schema.task_type == null) ?? null,
    [selectedSprintType],
  );
  const baseOutcomes = useMemo(
    () => (selectedSprintType?.outcomes ?? []).filter(outcome => outcome.task_type == null && !BACKEND_ONLY_OUTCOMES.has(outcome.outcome_key)),
    [selectedSprintType],
  );
  const taskTypeOutcomes = useMemo(
    () => (selectedSprintType?.outcomes ?? []).filter(outcome => outcome.task_type != null && !BACKEND_ONLY_OUTCOMES.has(outcome.outcome_key)),
    [selectedSprintType],
  );
  const overrideFieldSchemas = useMemo(
    () => (selectedSprintType?.field_schemas ?? [])
      .filter(schema => schema.task_type != null)
      .sort((a, b) => (a.task_type ?? '').localeCompare(b.task_type ?? '')),
    [selectedSprintType],
  );
  const fieldSchemasForTable = useMemo(
    () => [
      ...(baseFieldSchema ? [baseFieldSchema] : []),
      ...overrideFieldSchemas,
    ],
    [baseFieldSchema, overrideFieldSchemas],
  );
  const runOutcomesForTable = useMemo(
    () => [...baseOutcomes, ...taskTypeOutcomes],
    [baseOutcomes, taskTypeOutcomes],
  );
  const relationshipTypesForTable = useMemo(
    () => selectedSprintType?.relationship_types ?? [],
    [selectedSprintType],
  );

  const setSuccess = (message: string) => setNotice({ type: 'success', message });
  const setError = (error: unknown) => setNotice({ type: 'error', message: error instanceof Error ? error.message : String(error) });

  const closeSchemaEditor = () => {
    setSchemaEditor(null);
    setSchemaEditorPlacement(null);
  };

  const editDefaultSchema = (schema: FieldSchemaForm) => {
    setSchemaEditor(schema);
    setSchemaEditorPlacement({ kind: 'default' });
  };

  const editTaskTypeSchema = (schema: TaskFieldSchema) => {
    setSchemaEditor(schemaToForm(schema));
    setSchemaEditorPlacement({ kind: 'task-type', schemaId: schema.id });
  };

  const startNewBaseSchema = () => {
    setSchemaEditor(emptySchemaForm());
    setSchemaEditorPlacement({ kind: 'default' });
  };

  const startNewOverrideSchema = () => {
    setSchemaEditor(emptySchemaForm());
    setSchemaEditorPlacement({ kind: 'new-task-type' });
  };

  const closeOutcomeEditor = () => {
    setOutcomeEditor(null);
    setOutcomeEditorPlacement(null);
  };

  const startNewBaseOutcome = () => {
    setOutcomeEditor(emptyOutcomeForm());
    setOutcomeEditorPlacement('add-base');
  };

  const startNewTaskTypeOutcome = () => {
    setOutcomeEditor(emptyOutcomeForm('backend'));
    setOutcomeEditorPlacement('add-task-type');
  };

  const editOutcome = (outcome: SprintTypeOutcome) => {
    setOutcomeEditor(outcomeToForm(outcome));
    setOutcomeEditorPlacement('edit');
  };

  const startNewRelationshipType = () => setRelationshipTypeEditor(emptyRelationshipTypeForm());

  const editRelationshipType = (relationshipType: TaskRelationshipTypeConfig) => {
    setRelationshipTypeEditor(relationshipTypeToForm(relationshipType));
  };

  const closeRelationshipTypeEditor = () => setRelationshipTypeEditor(null);

  const submitCreateSprintType = async () => {
    if (!sprintTypeForm.key.trim() || !sprintTypeForm.name.trim()) {
      setNotice({ type: 'error', message: 'Workflow type key and name are required.' });
      return;
    }
    setSaving('create-sprint-type');
    try {
      await api.createSprintType({
        key: sprintTypeForm.key.trim(),
        name: sprintTypeForm.name.trim(),
        description: sprintTypeForm.description.trim(),
      });
      await load(sprintTypeForm.key.trim());
      setCreatingSprintType(false);
      setSuccess(`Created workflow type ${sprintTypeForm.key.trim()}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveSprintType = async () => {
    if (!selectedSprintType) return;
    setSaving('sprint-type');
    try {
      await api.updateSprintType(selectedSprintType.key, {
        name: sprintTypeForm.name.trim(),
        description: sprintTypeForm.description.trim(),
      });
      await load(selectedSprintType.key);
      setSuccess(`Saved workflow type ${selectedSprintType.key}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const deleteSprintType = async () => {
    if (!selectedSprintType) return;
    if (sprintTypeDeletionState?.protected) {
      const message = sprintTypeDeletionState.reason === 'generic'
        ? 'The generic workflow type is protected and cannot be deleted.'
        : sprintTypeDeletionState.reason === 'open_sprints'
          ? `This workflow type cannot be deleted while ${sprintTypeDeletionState.open_sprint_count} open workflow${sprintTypeDeletionState.open_sprint_count === 1 ? '' : 's'} reference it.`
          : 'This workflow type cannot be deleted right now.';
      window.alert(message);
      setNotice({ type: 'error', message });
      return;
    }
    if (!window.confirm(`Delete workflow type ${selectedSprintType.key}?`)) return;
    setSaving('delete-sprint-type');
    try {
      await api.deleteSprintType(selectedSprintType.key);
      await load();
      setSuccess(`Deleted workflow type ${selectedSprintType.key}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveTaskTypes = async () => {
    if (!selectedSprintType) return;
    const taskTypes = [...new Set(taskTypesText.split(/[,\n]/).map(value => value.trim()).filter(Boolean))];
    setSaving('task-types');
    try {
      await api.replaceSprintTypeTaskTypes(selectedSprintType.key, taskTypes);
      await load(selectedSprintType.key);
      setSuccess(`Updated allowed task types for ${selectedSprintType.key}.`);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveSchema = async () => {
    if (!selectedSprintType || !schemaEditor) return;
    const editingTaskTypeSchema = schemaEditorPlacement?.kind === 'new-task-type' || schemaEditorPlacement?.kind === 'task-type';
    if (editingTaskTypeSchema && !schemaEditor.task_type.trim()) {
      setNotice({ type: 'error', message: 'Task type is required for a task-type schema.' });
      return;
    }
    setSaving('schema');
    try {
      const payload = {
        task_type: schemaEditor.task_type.trim() || null,
        schema: {
          fields: schemaEditor.fields
            .filter(field => field.key?.trim())
            .map(field => ({
              key: field.key?.trim(),
              label: field.label?.trim(),
              type: field.type,
              required: Boolean(field.required),
              options: field.type === 'select' ? (field.options ?? []).map(option => option.trim()).filter(Boolean) : undefined,
              help_text: field.help_text?.trim(),
              system: Boolean(field.system),
            })),
        },
      };
      if (schemaEditor.id) {
        await api.updateTaskFieldSchema(selectedSprintType.key, schemaEditor.id, payload);
      } else {
        await api.createTaskFieldSchema(selectedSprintType.key, payload);
      }
      await load(selectedSprintType.key);
      closeSchemaEditor();
      setSuccess('Saved field schema.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveOutcome = async () => {
    if (!selectedSprintType || !outcomeEditor) return;
    setSaving('outcome');
    try {
      const payload = {
        task_type: outcomeEditor.task_type.trim() || null,
        outcome_key: outcomeEditor.outcome_key.trim(),
        label: outcomeEditor.label.trim(),
        description: outcomeEditor.description.trim(),
        enabled: outcomeEditor.enabled ? 1 : 0,
        behavior: outcomeEditor.behavior,
        badge_variant: outcomeEditor.badge_variant.trim() || null,
        stage_order: 0,
        metadata: {
          ...(outcomeEditor.failure_like ? { failure_like: true } : {}),
          ...(outcomeEditor.blocked_like ? { blocked_like: true } : {}),
        },
      };
      if (outcomeEditor.id) {
        await api.updateSprintOutcome(selectedSprintType.key, outcomeEditor.id, payload);
      } else {
        await api.createSprintOutcome(selectedSprintType.key, payload);
      }
      await load(selectedSprintType.key);
      closeOutcomeEditor();
      setSuccess('Saved outcome vocabulary entry.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const saveRelationshipType = async () => {
    if (!selectedSprintType || !relationshipTypeEditor) return;
    if (!relationshipTypeEditor.key.trim() || !relationshipTypeEditor.label.trim()) {
      setNotice({ type: 'error', message: 'Relationship type key and label are required.' });
      return;
    }
    if (relationshipTypeEditor.affects_dispatch_eligibility && relationshipTypeEditor.direction_semantics === 'informational') {
      setNotice({ type: 'error', message: 'Relationship types that affect dispatch eligibility must use directional semantics.' });
      return;
    }
    setSaving('relationship-type');
    try {
      const payload = {
        key: relationshipTypeEditor.key.trim(),
        label: relationshipTypeEditor.label.trim(),
        inverse_label: relationshipTypeEditor.inverse_label.trim(),
        category: relationshipTypeEditor.category.trim() || 'general',
        direction_semantics: relationshipTypeEditor.direction_semantics,
        affects_dispatch_eligibility: relationshipTypeEditor.affects_dispatch_eligibility ? 1 : 0,
        active_statuses: splitListInput(relationshipTypeEditor.active_statuses_text),
        resolved_statuses: splitListInput(relationshipTypeEditor.resolved_statuses_text),
        allow_create_related_task: relationshipTypeEditor.allow_create_related_task ? 1 : 0,
        default_related_task_type: relationshipTypeEditor.default_related_task_type.trim() || null,
        default_related_task_status: relationshipTypeEditor.default_related_task_status.trim() || null,
      };
      if (relationshipTypeEditor.id) {
        await api.updateSprintRelationshipType(selectedSprintType.key, relationshipTypeEditor.id, payload);
      } else {
        await api.createSprintRelationshipType(selectedSprintType.key, payload);
      }
      await load(selectedSprintType.key);
      closeRelationshipTypeEditor();
      setSuccess('Saved relationship type.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const deleteRelationshipType = async (relationshipType: TaskRelationshipTypeConfig) => {
    if (!selectedSprintType || !window.confirm(`Delete relationship type ${relationshipType.key}?`)) return;
    setSaving(`delete-relationship-type-${relationshipType.id}`);
    try {
      await api.deleteSprintRelationshipType(selectedSprintType.key, relationshipType.id);
      await load(selectedSprintType.key);
      if (relationshipTypeEditor?.id === relationshipType.id) closeRelationshipTypeEditor();
      setSuccess('Deleted relationship type.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const deleteOutcome = async (outcome: SprintTypeOutcome) => {
    if (!selectedSprintType || !window.confirm('Delete this outcome definition?')) return;
    setSaving(`delete-outcome-${outcome.id}`);
    try {
      await api.deleteSprintOutcome(selectedSprintType.key, outcome.id);
      await load(selectedSprintType.key);
      if (outcomeEditor?.id === outcome.id) closeOutcomeEditor();
      setSuccess('Deleted outcome vocabulary entry.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const openDeleteSchemaDialog = (schema: TaskFieldSchema) => {
    const label = schema.task_type?.trim() || 'default';
    setSchemaDeleteDialog({
      schema,
      expectedText: label,
      label,
    });
    setSchemaDeleteConfirmation('');
  };

  const closeDeleteSchemaDialog = () => {
    setSchemaDeleteDialog(null);
    setSchemaDeleteConfirmation('');
  };

  const deleteSchema = async () => {
    if (!selectedSprintType || !schemaDeleteDialog) return;
    const { schema, expectedText } = schemaDeleteDialog;
    if (schemaDeleteConfirmation !== expectedText) return;
    setSaving(`delete-schema-${schema.id}`);
    try {
      await api.deleteTaskFieldSchema(selectedSprintType.key, schema.id);
      await load(selectedSprintType.key);
      if (schemaEditor?.id === schema.id) closeSchemaEditor();
      closeDeleteSchemaDialog();
      setSuccess('Deleted field schema.');
    } catch (error) {
      setError(error);
    } finally {
      setSaving(null);
    }
  };

  const schemaEditorIsTaskType = schemaEditorPlacement?.kind === 'new-task-type' || schemaEditorPlacement?.kind === 'task-type';
  const schemaEditorPanel = schemaEditor ? (
    <div className="space-y-4 rounded-xl border border-amber-500/30 bg-slate-900/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">
            {schemaEditor.id
              ? (schemaEditor.task_type.trim() ? `Edit ${schemaEditor.task_type.trim()} task-type schema` : 'Edit default task field schema')
              : (schemaEditorPlacement?.kind === 'new-task-type' ? 'New task-type schema' : (schemaEditor.task_type.trim() ? `New ${schemaEditor.task_type.trim()} task-type schema` : 'New task field schema'))}
          </h3>
          <p className="mt-1 text-sm text-slate-400">
            {schemaEditorIsTaskType
              ? 'Enter the task type this schema should apply to.'
              : 'Leave task type blank to edit the default task field schema.'}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={closeSchemaEditor}>Close</Button>
      </div>
      <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder={schemaEditorIsTaskType ? 'Task type for this schema' : 'Task type for a task-type schema, or leave blank for the default task field schema'} value={schemaEditor.task_type} onChange={e => setSchemaEditor(editor => editor ? { ...editor, task_type: e.target.value } : editor)} />
      <div className="space-y-3">
        {schemaEditor.fields.map((field, index) => (
          <div key={index} className="space-y-3 rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <div className="grid gap-3 md:grid-cols-2">
              <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="field key" value={field.key ?? ''} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, key: e.target.value } : item) } : editor)} />
              <input className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="label" value={field.label ?? ''} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, label: e.target.value } : item) } : editor)} />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <select className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" value={field.type ?? 'text'} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, type: e.target.value, options: e.target.value === 'select' ? (item.options ?? []) : [] } : item) } : editor)}>
                {['text', 'textarea', 'url', 'select', 'number', 'checkbox'].map(type => <option key={type} value={type}>{type}</option>)}
              </select>
              <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={Boolean(field.required)} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, required: e.target.checked } : item) } : editor)} />Required</label>
              <Button size="sm" variant="ghost" onClick={() => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.filter((_, itemIndex) => itemIndex !== index).length ? editor.fields.filter((_, itemIndex) => itemIndex !== index) : [{ ...emptyField }] } : editor)}><Trash2 className="h-3.5 w-3.5" />Remove</Button>
            </div>
            <input className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="help text" value={field.help_text ?? ''} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, help_text: e.target.value } : item) } : editor)} />
            {field.type === 'select' && (
              <input className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" placeholder="options, comma separated" value={(field.options ?? []).join(', ')} onChange={e => setSchemaEditor(editor => editor ? { ...editor, fields: editor.fields.map((item, itemIndex) => itemIndex === index ? { ...item, options: e.target.value.split(',').map(option => option.trim()).filter(Boolean) } : item) } : editor)} />
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setSchemaEditor(editor => editor ? { ...editor, fields: [...editor.fields, { ...emptyField }] } : editor)}><Plus className="h-3.5 w-3.5" />Add field</Button>
        <Button size="sm" variant="primary" loading={saving === 'schema'} onClick={saveSchema}>Save schema</Button>
      </div>
    </div>
  ) : null;


  const relationshipTypeEditorPanel = relationshipTypeEditor ? (
    <div className="space-y-4 rounded-xl border border-amber-500/30 bg-slate-900/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">{relationshipTypeEditor.id ? 'Edit relationship type' : 'New relationship type'}</h3>
          <p className="mt-1 text-sm text-slate-400">Relationship types are workflow concepts used by Related Tasks and, optionally, dispatch eligibility.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={closeRelationshipTypeEditor}>Close</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="key, e.g. blocked_by" value={relationshipTypeEditor.key} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, key: e.target.value } : editor)} />
        <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="category, e.g. dependency" value={relationshipTypeEditor.category} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, category: e.target.value } : editor)} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="label, e.g. Blocked by" value={relationshipTypeEditor.label} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, label: e.target.value } : editor)} />
        <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="inverse label, e.g. Blocks" value={relationshipTypeEditor.inverse_label} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, inverse_label: e.target.value } : editor)} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <select className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" value={relationshipTypeEditor.direction_semantics} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, direction_semantics: e.target.value as RelationshipTypeForm['direction_semantics'] } : editor)}>
          <option value="informational">informational</option>
          <option value="target_blocks_source">target blocks source</option>
          <option value="source_blocks_target">source blocks target</option>
        </select>
        <label className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-100">
          <input type="checkbox" checked={relationshipTypeEditor.affects_dispatch_eligibility} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, affects_dispatch_eligibility: e.target.checked, direction_semantics: e.target.checked && editor.direction_semantics === 'informational' ? 'target_blocks_source' : editor.direction_semantics } : editor)} />
          Affects dispatch eligibility
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Active statuses</span>
          <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="optional, comma separated" value={relationshipTypeEditor.active_statuses_text} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, active_statuses_text: e.target.value } : editor)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Resolved statuses</span>
          <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="done, deployed" value={relationshipTypeEditor.resolved_statuses_text} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, resolved_statuses_text: e.target.value } : editor)} />
        </label>
      </div>
      <label className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-300">
        <input type="checkbox" checked={relationshipTypeEditor.allow_create_related_task} onChange={e => setRelationshipTypeEditor(editor => editor ? { ...editor, allow_create_related_task: e.target.checked } : editor)} />
        Allow users to create a related task from this relationship type
      </label>
      <Button variant="primary" loading={saving === 'relationship-type'} onClick={saveRelationshipType}>Save relationship type</Button>
    </div>
  ) : null;

  const outcomeEditorPanel = outcomeEditor ? (
    <div className="space-y-4 rounded-xl border border-amber-500/30 bg-slate-900/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">{outcomeEditor.id ? 'Edit outcome definition' : 'New outcome definition'}</h3>
          <p className="mt-1 text-sm text-slate-400">Leave task type blank for the base workflow vocabulary. Fill it in to create a task-type overlay.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={closeOutcomeEditor}>Close</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="task type override, or leave blank" value={outcomeEditor.task_type} onChange={e => setOutcomeEditor(editor => editor ? { ...editor, task_type: e.target.value, behavior: e.target.value.trim() ? (editor.behavior === 'base' ? 'extend' : editor.behavior) : 'base' } : editor)} />
        <select className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" value={outcomeEditor.behavior} onChange={e => setOutcomeEditor(editor => editor ? { ...editor, behavior: e.target.value as OutcomeForm['behavior'] } : editor)}>
          {(!outcomeEditor.task_type.trim() ? ['base'] : ['extend', 'override', 'disable']).map(mode => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="outcome key" value={outcomeEditor.outcome_key} onChange={e => setOutcomeEditor(editor => editor ? { ...editor, outcome_key: e.target.value } : editor)} />
        <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="label" value={outcomeEditor.label} onChange={e => setOutcomeEditor(editor => editor ? { ...editor, label: e.target.value } : editor)} />
      </div>
      <textarea className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" rows={3} placeholder="description" value={outcomeEditor.description} onChange={e => setOutcomeEditor(editor => editor ? { ...editor, description: e.target.value } : editor)} />
      <div className="grid gap-3 md:grid-cols-2">
        <select className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" value={outcomeEditor.badge_variant} onChange={e => setOutcomeEditor(editor => editor ? { ...editor, badge_variant: e.target.value } : editor)}>
          <option value="">badge variant: workspace default</option>
          {OUTCOME_BADGE_VARIANTS.map(variant => (
            <option key={variant} value={variant}>{variant}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={outcomeEditor.enabled} onChange={e => setOutcomeEditor(editor => editor ? { ...editor, enabled: e.target.checked } : editor)} />Enabled</label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={outcomeEditor.failure_like}
            onChange={e => setOutcomeEditor(editor => editor ? { ...editor, failure_like: e.target.checked, blocked_like: e.target.checked ? false : editor.blocked_like } : editor)}
          />
          Failure like
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={outcomeEditor.blocked_like}
            onChange={e => setOutcomeEditor(editor => editor ? { ...editor, blocked_like: e.target.checked, failure_like: e.target.checked ? false : editor.failure_like } : editor)}
          />
          Blocked like
        </label>
      </div>
      <Button variant="primary" loading={saving === 'outcome'} onClick={saveOutcome}>Save outcome definition</Button>
    </div>
  ) : null;

  const tabs: Array<{ id: SprintDefinitionTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'task-statuses', label: 'Status Labels', count: workflowStatuses.length },
    { id: 'task-fields', label: 'Task Fields', count: fieldSchemasForTable.length },
    { id: 'relationship-types', label: 'Relationships', count: relationshipTypesForTable.length },
    { id: 'outcomes', label: 'Run Outcomes', count: runOutcomesForTable.length },
  ];

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <Workflow className="h-5 w-5 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">Workflow Definitions</h1>
        </div>
        <p className="text-sm text-slate-400">
          Workflow-type configuration for task statuses, task fields, relationship types, run outcomes, and allowed task types.
        </p>
      </div>

      {notice && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${notice.type === 'error' ? 'border-rose-800/60 bg-rose-950/40 text-rose-200' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-200'}`}>
          {notice.message}
        </div>
      )}

      <Card className={SCOPE_CARD_CLASS} data-tour-target="sprint-definitions-main">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">Workflow Type</p>
            <p className="mt-1 text-base font-semibold text-white">
              {selectedSprintType ? `${selectedSprintType.name} (${selectedSprintType.key})` : 'Select or create a workflow type.'}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">Choose the workflow template whose labels, fields, outcomes, and task types you want to edit.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(280px,1fr)_auto] lg:min-w-[620px]">
            <div className="relative">
              <select
                className="w-full appearance-none rounded-lg border border-slate-700 bg-slate-800 py-2.5 pl-3 pr-8 text-sm text-slate-200 focus:border-amber-500 focus:outline-none disabled:opacity-60"
                value={selectedKey}
                onChange={e => setSelectedKey(e.target.value)}
                disabled={loading || config.length === 0}
              >
                {loading && <option value="">Loading workflow types...</option>}
                {!loading && config.length === 0 && <option value="">No workflow types</option>}
                {config.map(type => (
                  <option key={type.key} value={type.key}>{type.key}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setCreatingSprintType(true); setSprintTypeForm(emptySprintTypeForm); }}
            >
              <Plus className="h-3.5 w-3.5" /> New Workflow Type
            </Button>
          </div>
        </div>

        {creatingSprintType && (
          <div className="mt-4 grid gap-3 rounded-xl border border-slate-700 bg-slate-900/70 p-3 lg:grid-cols-[180px_220px_minmax(0,1fr)_auto]">
            <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="key" value={sprintTypeForm.key} onChange={e => setSprintTypeForm(form => ({ ...form, key: e.target.value }))} />
            <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="name" value={sprintTypeForm.name} onChange={e => setSprintTypeForm(form => ({ ...form, name: e.target.value }))} />
            <input className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" placeholder="description" value={sprintTypeForm.description} onChange={e => setSprintTypeForm(form => ({ ...form, description: e.target.value }))} />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" loading={saving === 'create-sprint-type'} onClick={submitCreateSprintType}>Create</Button>
              <Button size="sm" variant="ghost" onClick={() => setCreatingSprintType(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>

      {schemaDeleteDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeDeleteSchemaDialog} />
          <div className="relative w-full max-w-md space-y-5 rounded-xl border border-slate-700 bg-slate-800 p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-900/40">
                  <Trash2 className="h-4 w-4 text-red-400" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">Delete task field schema</h2>
                  <p className="mt-0.5 text-xs text-slate-400">This action cannot be undone</p>
                </div>
              </div>
              <button onClick={closeDeleteSchemaDialog} className="text-slate-500 transition-colors hover:text-slate-300">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-4">
              <div className="flex items-start gap-2 text-sm text-red-100/90">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <p>
                  This will permanently delete the <span className="font-mono text-red-100">{schemaDeleteDialog.label}</span> schema from workflow type <span className="font-mono text-red-100">{selectedSprintType?.key}</span>. This removes shared configuration, not just a local UI preference.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs text-slate-400">
                Type <span className="font-mono font-medium text-white">{schemaDeleteDialog.expectedText}</span> to confirm
              </label>
              <input
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white transition-colors focus:border-red-500 focus:outline-none"
                value={schemaDeleteConfirmation}
                onChange={event => setSchemaDeleteConfirmation(event.target.value)}
                placeholder={schemaDeleteDialog.expectedText}
                aria-label={`Type ${schemaDeleteDialog.expectedText} to confirm schema deletion`}
                autoFocus
                onKeyDown={event => event.key === 'Enter' && void deleteSchema()}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={closeDeleteSchemaDialog} disabled={saving === `delete-schema-${schemaDeleteDialog.schema.id}`}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={deleteSchema}
                loading={saving === `delete-schema-${schemaDeleteDialog.schema.id}`}
                disabled={schemaDeleteConfirmation !== schemaDeleteDialog.expectedText}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete schema
              </Button>
            </div>
          </div>
        </div>
      )}

      {selectedSprintType ? (
        <>
          <div className="overflow-x-auto border-b border-slate-700/50 scrollbar-none">
            <div className="flex min-w-max gap-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${activeTab === tab.id ? 'border-amber-400 text-amber-300' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                >
                  {tab.label}
                  {tab.count !== undefined && (
                    <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${activeTab === tab.id ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700 text-slate-500'}`}>
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'overview' && (
            <Card className="space-y-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <SectionHeader label="Overview" help={TAB_HELP.overview} />
                <Button size="sm" variant="danger" loading={saving === 'delete-sprint-type'} onClick={deleteSprintType}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </div>

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-[minmax(160px,0.45fr)_minmax(0,1fr)]">
                    <label className="block">
                      <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Key</span>
                      <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-400" value={sprintTypeForm.key} disabled />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Name</span>
                      <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" value={sprintTypeForm.name} onChange={e => setSprintTypeForm(form => ({ ...form, name: e.target.value }))} />
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Description</span>
                    <textarea className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" rows={4} value={sprintTypeForm.description} onChange={e => setSprintTypeForm(form => ({ ...form, description: e.target.value }))} />
                  </label>
                  <Button variant="primary" loading={saving === 'sprint-type'} onClick={saveSprintType}>
                    <Save className="h-3.5 w-3.5" /> Save Details
                  </Button>
                </div>

                <div className="space-y-4">
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Allowed task types</span>
                    <textarea className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" rows={8} value={taskTypesText} onChange={e => setTaskTypesText(e.target.value)} />
                  </label>
                  <Button variant="secondary" loading={saving === 'task-types'} onClick={saveTaskTypes}>Save Task Types</Button>
                </div>
              </div>
            </Card>
          )}

          {activeTab === 'task-statuses' && (
            <div className="space-y-4">
              <SectionHeader
                label="Status Labels"
                help={TAB_HELP['task-statuses']}
                actions={(
                  <Button size="sm" variant="secondary" onClick={() => setShowNewStatus(true)} disabled={showNewStatus}>
                    <Plus className="h-3.5 w-3.5" /> Add Status
                  </Button>
                )}
                actionsClassName="flex flex-wrap gap-2"
              />
              <TaskStatusesTable
                statuses={workflowStatuses}
                loading={statusLoading}
                sprintTypeKey={selectedSprintType.key}
                showNewStatus={showNewStatus}
                onCreated={() => {
                  setShowNewStatus(false);
                  void reloadStatuses(selectedSprintType.key);
                  setSuccess('Created status label.');
                }}
                onCancelNewStatus={() => setShowNewStatus(false)}
                onSaved={() => {
                  void reloadStatuses(selectedSprintType.key);
                  setSuccess('Saved status label.');
                }}
              />
            </div>
          )}

          {activeTab === 'task-fields' && (
            <div className="space-y-5">
              <SectionHeader
                label="Task Fields"
                help={TAB_HELP['task-fields']}
                actions={(
                  <>
                    {!baseFieldSchema && (
                      <Button size="sm" variant="secondary" onClick={startNewBaseSchema} disabled={schemaEditorPlacement?.kind === 'default'}>
                        <Plus className="h-3.5 w-3.5" /> Create default schema
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={startNewOverrideSchema} disabled={schemaEditorPlacement?.kind === 'new-task-type'}>
                      <Plus className="h-3.5 w-3.5" /> Add task-type schema
                    </Button>
                  </>
                )}
                actionsClassName="flex flex-wrap gap-2"
              />

              <TaskFieldSchemasTable
                schemas={fieldSchemasForTable}
                emptyMessage="No task field schemas configured yet."
                editorPanel={schemaEditorPanel}
                editingDefault={schemaEditorPlacement?.kind === 'default'}
                editingSchemaId={schemaEditorPlacement?.kind === 'task-type' ? schemaEditorPlacement.schemaId : null}
                addingTaskTypeSchema={schemaEditorPlacement?.kind === 'new-task-type'}
                onEdit={schema => {
                  if (schema.task_type == null) editDefaultSchema(schemaToForm(schema));
                  else editTaskTypeSchema(schema);
                }}
                onDelete={openDeleteSchemaDialog}
                saving={saving}
              />
            </div>
          )}


          {activeTab === 'relationship-types' && (
            <div className="space-y-4">
              <SectionHeader
                label="Relationship Types"
                help={TAB_HELP['relationship-types']}
                actions={(
                  <Button size="sm" variant="secondary" onClick={startNewRelationshipType} disabled={relationshipTypeEditor !== null && !relationshipTypeEditor.id}>
                    <Plus className="h-3.5 w-3.5" />Add relationship type
                  </Button>
                )}
                actionsClassName="flex flex-wrap gap-2"
              />

              <RelationshipTypesTable
                relationshipTypes={relationshipTypesForTable}
                emptyMessage="No relationship types configured yet. Add a type to make it available in Related Tasks."
                editorPanel={relationshipTypeEditorPanel}
                editingRelationshipTypeId={relationshipTypeEditor?.id ?? null}
                addingRelationshipType={relationshipTypeEditor !== null && !relationshipTypeEditor.id}
                onEdit={editRelationshipType}
                onDelete={deleteRelationshipType}
                saving={saving}
              />
            </div>
          )}

          {activeTab === 'outcomes' && (
            <div className="space-y-4">
              <SectionHeader
                label="Run Outcomes"
                help={TAB_HELP.outcomes}
                actions={(
                  <>
                    <Button size="sm" variant="secondary" onClick={startNewBaseOutcome} disabled={outcomeEditorPlacement === 'add-base'}><Plus className="h-3.5 w-3.5" />Add base outcome</Button>
                    <Button size="sm" variant="secondary" onClick={startNewTaskTypeOutcome} disabled={outcomeEditorPlacement === 'add-task-type'}><Plus className="h-3.5 w-3.5" />Add task-type overlay</Button>
                  </>
                )}
                actionsClassName="flex flex-wrap gap-2"
              />

              <RunOutcomesTable
                outcomes={runOutcomesForTable}
                emptyMessage="No run outcomes configured yet."
                editorPanel={outcomeEditorPanel}
                editingOutcomeId={outcomeEditorPlacement === 'edit' && outcomeEditor?.id ? outcomeEditor.id : null}
                addingOutcome={outcomeEditorPlacement !== null && outcomeEditorPlacement !== 'edit'}
                onEdit={editOutcome}
                onDelete={deleteOutcome}
                saving={saving}
              />
            </div>
          )}
        </>
      ) : (
        <Card><p className="text-sm text-slate-400">Select a workflow type to configure it.</p></Card>
      )}
    </div>
  );
}
