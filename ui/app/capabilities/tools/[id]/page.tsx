'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, ToolEntry, Agent } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Trash2, Save, X, Plus, Bot, Play, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import Link from 'next/link';

const PERMISSION_OPTIONS = ['read_only', 'read_write', 'exec', 'network', 'admin'];
const IMPL_TYPE_OPTIONS = ['bash', 'mcp', 'function', 'http'];

export default function ToolDetailPage() {
  const params = useParams();
  const router = useRouter();
  const isNew = params.id === 'new';
  const toolId = isNew ? null : Number(params.id);

  const [tool, setTool] = useState<ToolEntry | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [implType, setImplType] = useState<string>('bash');
  const [implBody, setImplBody] = useState('');
  const [inputSchema, setInputSchema] = useState('{}');
  const [permissions, setPermissions] = useState('read_only');
  const [tagsRaw, setTagsRaw] = useState('');
  const [enabled, setEnabled] = useState(true);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Delete state
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Assigned agents
  const [allAgents, setAllAgents] = useState<Agent[]>([]);

  useEffect(() => {
    if (isNew) {
      api.getAgents().then(setAllAgents).catch(() => {});
      return;
    }
    Promise.all([
      api.getTool(toolId!),
      api.getAgents(),
    ])
      .then(([t, agents]) => {
        setTool(t);
        setAllAgents(agents);
        // Populate form
        setName(t.name);
        setSlug(t.slug);
        setDescription(t.description ?? '');
        setImplType(t.implementation_type);
        setImplBody(t.implementation_body ?? '');
        setInputSchema(t.input_schema ?? '{}');
        setPermissions(t.permissions);
        setEnabled(!!t.enabled);
        try {
          const tags = JSON.parse(t.tags) as string[];
          setTagsRaw(tags.join(', '));
        } catch {
          setTagsRaw('');
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [toolId, isNew]);


  const parseTags = (raw: string): string[] =>
    raw.split(',').map(t => t.trim()).filter(Boolean);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const payload: Partial<ToolEntry> = {
      name,
      slug,
      description,
      implementation_type: implType as ToolEntry['implementation_type'],
      implementation_body: implBody,
      input_schema: inputSchema,
      permissions: permissions as ToolEntry['permissions'],
      tags: JSON.stringify(parseTags(tagsRaw)),
      enabled: enabled ? 1 : 0,
    };
    try {
      if (isNew) {
        const created = await api.createTool(payload);
        router.push(`/capabilities/tools/${created.id}`);
      } else {
        const updated = await api.updateTool(toolId!, payload);
        setTool(updated);
        setName(updated.name);
        setSlug(updated.slug);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteTool(toolId!);
      router.push('/capabilities');
    } catch (e) {
      alert(`Delete failed: ${e}`);
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };


  // Auto-slug from name
  const handleNameChange = (v: string) => {
    setName(v);
    if (isNew || !tool) {
      setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );


  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/capabilities')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-white">
            {isNew ? 'New Tool' : (tool?.name ?? 'Tool')}
          </h1>
          {!isNew && tool && (
            <p className="text-slate-400 text-xs font-mono mt-0.5">{tool.slug}</p>
          )}
        </div>
        {!isNew && (
          deleteConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-400">Disable?</span>
              <Button variant="danger" size="sm" onClick={handleDelete} loading={deleting}>Yes</Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(true)} className="text-red-400 hover:text-red-300" title="Disable tool">
              <Trash2 className="w-4 h-4" />
            </Button>
          )
        )}
      </div>

      {/* Editor */}
      <Card>
        <div className="space-y-4">
          {/* Name + Slug */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Name</label>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={name}
                onChange={e => handleNameChange(e.target.value)}
                placeholder="My Tool"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Slug</label>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
                value={slug}
                onChange={e => setSlug(e.target.value)}
                placeholder="my_tool"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Description</label>
            <textarea
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 resize-none"
              rows={2}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this tool do?"
            />
          </div>

          {/* Implementation type */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Implementation Type</label>
              <select
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={implType}
                onChange={e => setImplType(e.target.value)}
              >
                {IMPL_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Permissions</label>
              <select
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={permissions}
                onChange={e => setPermissions(e.target.value)}
              >
                {PERMISSION_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          {/* Implementation body */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Implementation Body</label>
            <textarea
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-green-300 text-sm font-mono focus:outline-none focus:border-amber-500 resize-y"
              rows={8}
              value={implBody}
              onChange={e => setImplBody(e.target.value)}
              placeholder={implType === 'bash' ? '#!/bin/bash\n# your script here' : 'implementation body'}
              spellCheck={false}
            />
          </div>

          {/* Input Schema */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Input Schema (JSON)</label>
            <textarea
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-blue-300 text-sm font-mono focus:outline-none focus:border-amber-500 resize-y"
              rows={4}
              value={inputSchema}
              onChange={e => setInputSchema(e.target.value)}
              placeholder='{"type":"object","properties":{}}'
              spellCheck={false}
            />
          </div>

          {/* Tags */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Tags (comma-separated)</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
              value={tagsRaw}
              onChange={e => setTagsRaw(e.target.value)}
              placeholder="shell, automation, dev"
            />
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setEnabled(v => !v)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-amber-500' : 'bg-slate-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
            </button>
            <span className="text-sm text-slate-300">{enabled ? 'Enabled' : 'Disabled'}</span>
          </div>

          {saveError && <p className="text-red-400 text-sm">{saveError}</p>}

          <div className="flex gap-2 pt-2">
            <Button variant="primary" onClick={handleSave} loading={saving}>
              <Save className="w-4 h-4" /> Save
            </Button>
            <Button variant="ghost" onClick={() => router.push('/capabilities')}>
              <X className="w-4 h-4" /> Cancel
            </Button>
          </div>
        </div>
      </Card>

      {/* Assigned to — only for existing tools */}
      {!isNew && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Bot className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Assigned to Agents</h2>
          </div>

          <AssignedAgentsSection
            toolId={toolId!}
            allAgents={allAgents}
          />
        </Card>
      )}

      {/* Test runner — only for existing tools */}
      {!isNew && (
        <ToolTestPanel toolId={toolId!} inputSchema={inputSchema} />
      )}
    </div>
  );
}

/* ─── Tool Test Panel ────────────────────────────────────────────────────── */

function buildSchemaExample(schemaJson: string): string {
  try {
    const schema = JSON.parse(schemaJson);
    if (!schema || typeof schema !== 'object') return '{}';
    const props: Record<string, unknown> = schema.properties ?? {};
    const example: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(props)) {
      const d = def as any;
      if (d.default !== undefined) { example[key] = d.default; continue; }
      if (d.enum && Array.isArray(d.enum) && d.enum.length > 0) { example[key] = d.enum[0]; continue; }
      switch (d.type) {
        case 'string':  example[key] = ''; break;
        case 'number':
        case 'integer': example[key] = 0; break;
        case 'boolean': example[key] = false; break;
        case 'array':   example[key] = []; break;
        case 'object':  example[key] = {}; break;
        default:        example[key] = null;
      }
    }
    return JSON.stringify(example, null, 2);
  } catch {
    return '{}';
  }
}

function ToolTestPanel({ toolId, inputSchema }: { toolId: number; inputSchema: string }) {
  const [inputJson, setInputJson] = useState(() => buildSchemaExample(inputSchema));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ output: string | null; duration_ms: number; error?: string } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Re-build example when schema changes
  useEffect(() => {
    setInputJson(buildSchemaExample(inputSchema));
    setResult(null);
  }, [inputSchema]);

  const handleRun = async () => {
    setParseError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(inputJson);
    } catch (e) {
      setParseError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await api.testTool(toolId, parsed);
      setResult(res);
    } catch (e) {
      setResult({ output: null, duration_ms: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Play className="w-4 h-4 text-amber-400" />
        <h2 className="font-semibold text-white">Test Runner</h2>
      </div>

      {/* Input editor */}
      <div className="space-y-3">
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Input (JSON)</label>
          <textarea
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-blue-300 text-sm font-mono focus:outline-none focus:border-amber-500 resize-y"
            rows={6}
            value={inputJson}
            onChange={e => { setInputJson(e.target.value); setParseError(null); }}
            spellCheck={false}
            placeholder="{}"
          />
          {parseError && (
            <p className="text-red-400 text-xs mt-1">{parseError}</p>
          )}
        </div>

        <Button variant="primary" size="sm" onClick={handleRun} loading={running} disabled={running}>
          <Play className="w-3.5 h-3.5" /> Run
        </Button>

        {/* Output */}
        {result && (
          <div className="space-y-2 pt-2">
            {/* Status bar */}
            <div className="flex items-center gap-2 text-xs">
              {result.error ? (
                <><AlertCircle className="w-3.5 h-3.5 text-red-400" /><span className="text-red-400">Error</span></>
              ) : (
                <><CheckCircle className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400">Success</span></>
              )}
              <span className="text-slate-500 ml-auto flex items-center gap-1">
                <Clock className="w-3 h-3" /> {result.duration_ms}ms
              </span>
            </div>

            {/* Output block */}
            {result.error ? (
              <div className="bg-red-950/40 border border-red-800/50 rounded-lg p-3">
                <pre className="text-red-300 text-xs font-mono whitespace-pre-wrap break-all">{result.error}</pre>
              </div>
            ) : (
              <div className="bg-slate-900 border border-slate-700 rounded-lg p-3">
                <pre className="text-green-300 text-xs font-mono whitespace-pre-wrap break-all">{result.output ?? '(no output)'}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ─── Assigned Agents Sub-component ─────────────────────────────────────── */

function AssignedAgentsSection({ toolId, allAgents }: { toolId: number; allAgents: Agent[] }) {
  const [agentAssignments, setAgentAssignments] = useState<Array<{ agent: Agent; toolId: number; assignmentId: number }>>([]);
  const [loaded, setLoaded] = useState(false);
  const [addAgentId, setAddAgentId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [unassigning, setUnassigning] = useState<number | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  const load = async () => {
    const result: Array<{ agent: Agent; toolId: number; assignmentId: number }> = [];
    await Promise.all(
      allAgents.map(async (agent) => {
        try {
          const agentTools = await api.getAgentTools(agent.id);
          const match = agentTools.find(at => at.tool_id === toolId);
          if (match) {
            result.push({
              agent,
              toolId: match.tool_id,
              assignmentId: match.assignment_id,
            });
          }
        } catch {}
      })
    );
    setAgentAssignments(result);
    setLoaded(true);
  };

  useEffect(() => { load(); }, [toolId, allAgents]);

  const assignedAgentIds = new Set(agentAssignments.map(a => a.agent.id));
  const unassignedAgents = allAgents.filter(a => !assignedAgentIds.has(a.id));

  const handleAssign = async () => {
    if (!addAgentId) return;
    setAssigning(true);
    setAssignError(null);
    try {
      await api.assignAgentTool(Number(addAgentId), toolId);
      setAddAgentId('');
      await load();
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : String(e));
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassign = async (agentId: number, assignedToolId: number) => {
    setUnassigning(agentId);
    try {
      // Canonical contract: unassign by tool_id. assignment_id is join-row metadata only.
      await api.unassignAgentTool(agentId, assignedToolId);
      setAgentAssignments(prev => prev.filter(a => !(a.agent.id === agentId && a.toolId === assignedToolId)));
    } catch (e) {
      alert(`Unassign failed: ${e}`);
    } finally {
      setUnassigning(null);
    }
  };

  if (!loaded) return (
    <div className="flex items-center gap-2 text-slate-400 text-sm">
      <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      Loading assignments…
    </div>
  );

  return (
    <div className="space-y-3">
      {agentAssignments.length === 0 ? (
        <p className="text-slate-500 text-sm">Not assigned to any agents</p>
      ) : (
        <div className="space-y-2">
          {agentAssignments.map(({ agent, toolId: assignedToolId, assignmentId }) => (
            <div key={assignmentId} className="flex items-center gap-3 py-1.5 border-b border-slate-700/30 last:border-0">
              <Bot className="w-4 h-4 text-slate-400 shrink-0" />
              <Link href={`/agents/${agent.id}`} className="flex-1 text-sm text-slate-300 hover:text-white">
                {agent.name}
              </Link>
              <button
                onClick={() => handleUnassign(agent.id, assignedToolId)}
                disabled={unassigning === agent.id}
                className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              >
                {unassigning === agent.id ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add assignment */}
      {unassignedAgents.length > 0 && (
        <div className="flex gap-2 pt-2">
          <select
            className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
            value={addAgentId}
            onChange={e => setAddAgentId(e.target.value)}
          >
            <option value="">Add agent…</option>
            {unassignedAgents.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <Button variant="primary" size="sm" onClick={handleAssign} loading={assigning} disabled={!addAgentId}>
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
        </div>
      )}
      {assignError && <p className="text-red-400 text-xs">{assignError}</p>}
    </div>
  );
}
