'use client';

import { useMemo, useState } from 'react';
import { api, type TaskStatusMeta } from '@/lib/api';
import { getTaskStatusEmoji, normalizeTaskStatusEmojiInput } from '@/lib/taskStatusEmoji';
import { TableColumnFilter, matchesColumnFilter, uniqueColumnOptions } from '@/components/TableColumnFilter';
import { Button } from '@/components/ui/button';
import { COLOR_BADGE_CLASSES } from '@/components/workflowConfig';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { COLOR_CLASSES, COLOR_OPTIONS, STATUS_COLUMN_HELP } from '../workflowDefinitionShared';

function SprintDefinitionStatusRow({
  sprintTypeKey,
  status,
  onSaved,
}: {
  sprintTypeKey: string;
  status: TaskStatusMeta;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(status.label);
  const [emoji, setEmoji] = useState(getTaskStatusEmoji(status));
  const [color, setColor] = useState(status.color);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const startEdit = () => {
    setLabel(status.label);
    setEmoji(getTaskStatusEmoji(status));
    setColor(status.color);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateSprintTypeStatus(sprintTypeKey, status.name, { label, color, emoji: normalizeTaskStatusEmojiInput(emoji) ?? '' });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteStatus = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteSprintTypeStatus(sprintTypeKey, status.name);
      setDeleteConfirm(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <tr className="border-b border-slate-700/50 transition-colors hover:bg-slate-800/30">
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs text-slate-300">{status.name}</code>
          {status.is_system && (
            <span className="rounded-full border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
              starter
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-3">
        {editing ? (
          <input
            className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white focus:border-amber-500 focus:outline-none"
            value={label}
            onChange={event => setLabel(event.target.value)}
          />
        ) : (
          <span className="text-xs text-slate-200">{status.label}</span>
        )}
      </td>
      <td className="px-3 py-3">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white focus:border-amber-500 focus:outline-none"
              value={emoji}
              onChange={event => setEmoji(event.target.value)}
              placeholder="Optional emoji"
              aria-label={`Emoji for ${status.name}`}
            />
            {emoji.trim().length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setEmoji('')} className="whitespace-nowrap text-slate-400 hover:text-slate-100">
                Clear
              </Button>
            )}
          </div>
        ) : (
          <span className="text-lg leading-none text-slate-200">{getTaskStatusEmoji(status) || '—'}</span>
        )}
      </td>
      <td className="px-3 py-3">
        {editing ? (
          <div className="flex flex-wrap gap-1.5">
            {COLOR_OPTIONS.map(option => (
              <button
                key={option}
                type="button"
                onClick={() => setColor(option)}
                title={option}
                className={`h-5 w-5 rounded-full ${COLOR_CLASSES[option] ?? COLOR_CLASSES.slate} ${color === option ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-800' : 'opacity-60 hover:opacity-100'}`}
              />
            ))}
          </div>
        ) : (
          <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${COLOR_BADGE_CLASSES[status.color] ?? COLOR_BADGE_CLASSES.slate}`}>
            {status.color}
          </span>
        )}
      </td>
      <td className="px-3 py-3 text-center">
        {status.terminal ? <span className="text-xs text-green-400">yes</span> : <span className="text-xs text-slate-600">no</span>}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1">
          {(status.allowed_transitions ?? []).length > 0 ? status.allowed_transitions.map(destination => (
            <span key={destination} className="rounded bg-slate-700/50 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
              {destination}
            </span>
          )) : (
            <span className="text-xs text-slate-600">No automatic destinations</span>
          )}
        </div>
      </td>
      <td className="px-3 py-3 text-right">
        {deleteConfirm ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" loading={deleting} onClick={deleteStatus} className="text-red-400 hover:bg-red-900/20 hover:text-red-300">
              <Trash2 className="h-3 w-3" />Yes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(false)}><X className="h-3 w-3" /></Button>
          </div>
        ) : editing ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="primary" loading={saving} onClick={save}><Check className="h-3 w-3" />Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null); }}><X className="h-3 w-3" /></Button>
          </div>
        ) : (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={startEdit}><Pencil className="h-3.5 w-3.5" />Edit</Button>
            <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(true)} className="text-red-400 hover:bg-red-900/20 hover:text-red-300">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {error && <p className="mt-1 text-right text-[10px] text-red-400">{error}</p>}
      </td>
    </tr>
  );
}

function NewSprintTypeStatusRow({
  sprintTypeKey,
  onCreated,
  onCancel,
}: {
  sprintTypeKey: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [emoji, setEmoji] = useState('');
  const [color, setColor] = useState('slate');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim() || !label.trim()) {
      setError('Name and label are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createSprintTypeStatus(sprintTypeKey, {
        name: name.trim().toLowerCase().replace(/\s+/g, '_'),
        label: label.trim(),
        color,
        ...(normalizeTaskStatusEmojiInput(emoji) ? { emoji: normalizeTaskStatusEmojiInput(emoji) } : {}),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-b border-amber-500/20 bg-amber-500/5">
      <td className="px-3 py-3">
        <input className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1.5 font-mono text-sm text-white" placeholder="status_key" value={name} onChange={event => setName(event.target.value)} />
      </td>
      <td className="px-3 py-3">
        <input className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white" placeholder="Label" value={label} onChange={event => setLabel(event.target.value)} />
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <input className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white" placeholder="Optional emoji" value={emoji} onChange={event => setEmoji(event.target.value)} aria-label="New status emoji" />
          {emoji.trim().length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setEmoji('')} className="whitespace-nowrap text-slate-400 hover:text-slate-100">Clear</Button>
          )}
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1.5">
          {COLOR_OPTIONS.map(option => (
            <button
              key={option}
              type="button"
              title={option}
              onClick={() => setColor(option)}
              className={`h-5 w-5 rounded-full ${COLOR_CLASSES[option] ?? COLOR_CLASSES.slate} ${color === option ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-800' : 'opacity-60 hover:opacity-100'}`}
            />
          ))}
        </div>
      </td>
      <td className="px-3 py-3 text-center"><span className="text-xs text-slate-600">no</span></td>
      <td className="px-3 py-3"><span className="text-xs text-slate-600">No automatic destinations</span></td>
      <td className="px-3 py-3 text-right">
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="primary" loading={saving} onClick={create}><Check className="h-3 w-3" />Create</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}><X className="h-3 w-3" /></Button>
        </div>
        {error && <p className="mt-1 text-right text-[10px] text-red-400">{error}</p>}
      </td>
    </tr>
  );
}

export function TaskStatusesTable({
  statuses,
  loading,
  sprintTypeKey,
  showNewStatus,
  onCreated,
  onCancelNewStatus,
  onSaved,
}: {
  statuses: TaskStatusMeta[];
  loading: boolean;
  sprintTypeKey: string;
  showNewStatus: boolean;
  onCreated: () => void;
  onCancelNewStatus: () => void;
  onSaved: () => void;
}) {
  const [filterCodes, setFilterCodes] = useState<string[]>([]);
  const [filterLabels, setFilterLabels] = useState<string[]>([]);
  const [filterEmojis, setFilterEmojis] = useState<string[]>([]);
  const [filterColors, setFilterColors] = useState<string[]>([]);
  const [filterTerminal, setFilterTerminal] = useState<string[]>([]);
  const [filterTransitions, setFilterTransitions] = useState<string[]>([]);
  const codeOptions = useMemo(() => statuses.map(status => ({ value: status.name, label: status.name })), [statuses]);
  const labelOptions = useMemo(() => statuses.map(status => ({ value: status.label, label: status.label })), [statuses]);
  const emojiOptions = useMemo(() => uniqueColumnOptions([
    { value: '', label: 'No emoji' },
    ...statuses.map(status => ({ value: getTaskStatusEmoji(status), label: getTaskStatusEmoji(status) || 'No emoji' })),
  ]), [statuses]);
  const colorOptions = useMemo(() => statuses.map(status => ({ value: status.color, label: status.color })), [statuses]);
  const terminalOptions = useMemo(() => ([
    { value: 'yes', label: 'yes' },
    { value: 'no', label: 'no' },
  ]), []);
  const transitionOptions = useMemo(() => uniqueColumnOptions([
    { value: '', label: 'No automatic destinations' },
    ...statuses.flatMap(status => (status.allowed_transitions ?? []).map(destination => ({ value: destination, label: destination }))),
  ]), [statuses]);
  const filteredStatuses = useMemo(() => statuses.filter(status => {
    const transitionValues = status.allowed_transitions?.length ? status.allowed_transitions : [''];
    return matchesColumnFilter(filterCodes, status.name)
      && matchesColumnFilter(filterLabels, status.label)
      && matchesColumnFilter(filterEmojis, getTaskStatusEmoji(status))
      && matchesColumnFilter(filterColors, status.color)
      && matchesColumnFilter(filterTerminal, status.terminal ? 'yes' : 'no')
      && (filterTransitions.length === 0 || transitionValues.some(destination => filterTransitions.includes(destination)));
  }), [filterCodes, filterColors, filterEmojis, filterLabels, filterTerminal, filterTransitions, statuses]);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/60">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-700 text-left">
              <th className="px-3 py-2.5"><TableColumnFilter label="Code" description={STATUS_COLUMN_HELP.code} selected={filterCodes} onChange={setFilterCodes} options={codeOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Label" description={STATUS_COLUMN_HELP.label} selected={filterLabels} onChange={setFilterLabels} options={labelOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Emoji" description={STATUS_COLUMN_HELP.emoji} selected={filterEmojis} onChange={setFilterEmojis} options={emojiOptions} /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Color" description={STATUS_COLUMN_HELP.color} selected={filterColors} onChange={setFilterColors} options={colorOptions} /></th>
              <th className="px-3 py-2.5 text-center"><TableColumnFilter label="Terminal" description={STATUS_COLUMN_HELP.terminal} selected={filterTerminal} onChange={setFilterTerminal} options={terminalOptions} align="center" /></th>
              <th className="px-3 py-2.5"><TableColumnFilter label="Allowed Next Statuses" description={STATUS_COLUMN_HELP.transitions} selected={filterTransitions} onChange={setFilterTransitions} options={transitionOptions} /></th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-slate-400"><ColumnHeaderLabel label="Actions" description={STATUS_COLUMN_HELP.actions} align="right" /></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-sm text-slate-400">Loading task statuses...</td>
              </tr>
            ) : statuses.length === 0 && !showNewStatus ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-sm text-slate-400">No task statuses found.</td>
              </tr>
            ) : (
              <>
                {showNewStatus && (
                  <NewSprintTypeStatusRow sprintTypeKey={sprintTypeKey} onCreated={onCreated} onCancel={onCancelNewStatus} />
                )}
                {filteredStatuses.map(status => (
                  <SprintDefinitionStatusRow key={status.name} sprintTypeKey={sprintTypeKey} status={status} onSaved={onSaved} />
                ))}
                {filteredStatuses.length === 0 && statuses.length > 0 && !showNewStatus && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-sm text-slate-400">No status labels match the current filters.</td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
