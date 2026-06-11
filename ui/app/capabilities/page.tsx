'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, McpServer, SkillEntry, Tool } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  BookOpen, Plus, X, Check, Search, Wrench, ChevronRight,
  ToggleLeft, ToggleRight, Trash2, Filter, Server,
} from 'lucide-react';
import Link from 'next/link';

type SubTab = 'skills' | 'tools' | 'mcp';

// ---------------------------------------------------------------------------
// Skills sub-section (preserved original SkillsPage logic)
// ---------------------------------------------------------------------------
function SkillsSection() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    api.getSkills()
      .then(setSkills)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createSkill(newName.trim());
      setSkills(prev => [...prev, {
        id: (created as any).id ?? null,
        name: newName.trim(),
        source: 'atlas' as const,
        description: '',
        files: [],
        created_at: (created as any).created_at ?? null,
        updated_at: (created as any).updated_at ?? null,
      }]);
      setNewName('');
      setShowCreate(false);
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (name: string) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSkill(name);
      setSkills(prev => prev.filter(s => s.name !== name));
      setDeleteTarget(null);
    } catch (e) {
      setDeleteError(String(e));
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-48">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  const filtered = skills.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));
  const managedSkills = filtered.filter(s => s.source === 'atlas' || s.source === 'workspace');
  const systemSkills = filtered.filter(s => s.source === 'system');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm">
          {skills.length} skills ({managedSkills.length} managed, {systemSkills.length} system)
        </p>
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4" /> New Skill
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-4 py-2.5 text-white text-sm focus:outline-none focus:border-amber-500"
          placeholder="Search skills…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {showCreate && (
        <Card className="border-amber-500/30">
          <h2 className="font-semibold text-white mb-3">Create New Skill</h2>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="my-new-skill"
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
            />
            <Button variant="primary" size="sm" onClick={handleCreate} loading={creating}>
              <Check className="w-3.5 h-3.5" /> Create
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
          {createError && <p className="text-red-400 text-xs mt-2">{createError}</p>}
        </Card>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <Card className="border-red-700/50 max-w-md w-full mx-4">
            <div className="flex items-start gap-3 mb-4">
              <div className="p-2 bg-red-900/30 rounded-lg">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h2 className="font-semibold text-white text-lg">Delete Skill</h2>
                <p className="text-slate-400 text-sm mt-1">
                  Are you sure you want to delete <span className="text-white font-medium">{deleteTarget}</span>?
                  This will permanently remove the skill directory and all its files.
                </p>
                <p className="text-slate-500 text-xs mt-2">
                  Any agents or configurations referencing this skill may be affected.
                </p>
              </div>
            </div>
            {deleteError && (
              <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm mb-4">{deleteError}</div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setDeleteTarget(null); setDeleteError(null); }} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => handleDelete(deleteTarget)} loading={deleting}>
                <Trash2 className="w-3.5 h-3.5" /> Delete Skill
              </Button>
            </div>
          </Card>
        </div>
      )}

      {managedSkills.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Managed Skills</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {managedSkills.map(skill => (
              <div key={skill.name} className="relative group">
                <Link href={`/skills/${encodeURIComponent(skill.name)}`}>
                  <Card className="hover:border-slate-500 transition-colors cursor-pointer h-full">
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-violet-900/30 rounded-lg">
                        <BookOpen className="w-4 h-4 text-violet-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-white text-sm truncate">{skill.name}</p>
                        {skill.description && (
                          <p className="text-xs text-slate-500 truncate mt-0.5">{skill.description}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant={skill.source === 'workspace' ? 'workspace' : 'info'}>
                            {skill.source}
                          </Badge>
                          {skill.files.length > 0 && (
                            <span className="text-xs text-slate-500">{skill.files.length} file{skill.files.length !== 1 ? 's' : ''}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </Card>
                </Link>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget(skill.name); setDeleteError(null); }}
                  className="absolute top-3 right-3 p-1.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-slate-500 hover:text-red-400 hover:border-red-700/40 hover:bg-red-900/20 opacity-0 group-hover:opacity-100 transition-all"
                  title="Delete skill"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {systemSkills.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">System Skills</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {systemSkills.map(skill => (
              <Link key={skill.name} href={`/skills/${encodeURIComponent(skill.name)}`}>
                <Card className="hover:border-slate-500 transition-colors cursor-pointer h-full opacity-80">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-slate-700 rounded-lg">
                      <BookOpen className="w-4 h-4 text-slate-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-white text-sm truncate">{skill.name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="system">system</Badge>
                        <span className="text-xs text-slate-500">{skill.files.length} file{skill.files.length !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 && (
        <Card>
          <div className="text-center py-12 text-slate-500">
            {search ? `No skills matching "${search}"` : 'No skills found'}
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools sub-section
// ---------------------------------------------------------------------------
type ToolDetailPanel = 'new' | number | null;

function ToolsSection() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [filterEnabled, setFilterEnabled] = useState<'all' | '1' | '0'>('1');
  const [filterPermission, setFilterPermission] = useState('');
  const [activePanel, setActivePanel] = useState<ToolDetailPanel>(null);

  const loadTools = useCallback(() => {
    setLoading(true);
    const params: { tag?: string; enabled?: 0 | 1 } = {};
    if (filterTag) params.tag = filterTag;
    if (filterEnabled !== 'all') params.enabled = Number(filterEnabled) as 0 | 1;
    api.getTools(params)
      .then(setTools)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [filterTag, filterEnabled]);

  useEffect(() => { loadTools(); }, [loadTools]);

  const handleToggleEnabled = async (tool: Tool, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.updateTool(tool.id, { enabled: tool.enabled ? 0 : 1 });
      setTools(prev => prev.map(t => t.id === tool.id ? { ...t, enabled: tool.enabled ? 0 : 1 } : t));
    } catch (err) {
      alert(`Failed to toggle tool: ${err}`);
    }
  };

  // Collect all unique tags from loaded tools
  const allTags = Array.from(new Set(
    tools.flatMap(t => { try { return JSON.parse(t.tags) as string[]; } catch { return []; } })
  )).sort();

  const allPermissions = Array.from(new Set(tools.map(t => t.permissions).filter(Boolean))).sort();

  const filtered = tools.filter(t => {
    const matchSearch = !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.slug.toLowerCase().includes(search.toLowerCase()) ||
      t.description?.toLowerCase().includes(search.toLowerCase());
    const matchPerm = !filterPermission || t.permissions === filterPermission;
    return matchSearch && matchPerm;
  });

  if (activePanel !== null) {
    return (
      <ToolEditor
        toolId={activePanel === 'new' ? null : activePanel}
        onClose={() => setActivePanel(null)}
        onSaved={() => { setActivePanel(null); loadTools(); }}
        onDeleted={() => { setActivePanel(null); loadTools(); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm">{tools.length} tool{tools.length !== 1 ? 's' : ''} registered</p>
        <Button variant="primary" size="sm" onClick={() => setActivePanel('new')}>
          <Plus className="w-4 h-4" /> New Tool
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-4 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
            placeholder="Search tools…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-amber-500"
          value={filterTag}
          onChange={e => setFilterTag(e.target.value)}
        >
          <option value="">All tags</option>
          {allTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        <select
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-amber-500"
          value={filterPermission}
          onChange={e => setFilterPermission(e.target.value)}
        >
          <option value="">All permissions</option>
          {allPermissions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-amber-500"
          value={filterEnabled}
          onChange={e => setFilterEnabled(e.target.value as 'all' | '1' | '0')}
        >
          <option value="1">Active tools</option>
          <option value="all">All tools</option>
          <option value="0">Disabled tools</option>
        </select>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-48">
          <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
      )}

      {!loading && !error && (
        <>
          {filtered.length === 0 ? (
            <Card>
              <div className="text-center py-12 text-slate-500">
                {search || filterTag || filterPermission || filterEnabled !== '1'
                  ? 'No tools match the current filters'
                  : 'No active tools registered yet'}
              </div>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-700/60">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/60 bg-slate-800/40">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide hidden md:table-cell">Slug</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide hidden lg:table-cell">Tags</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide hidden lg:table-cell">Permissions</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide hidden md:table-cell">Type</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Enabled</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(tool => {
                    let tags: string[] = [];
                    try { tags = JSON.parse(tool.tags); } catch {}
                    return (
                      <tr
                        key={tool.id}
                        className="border-b border-slate-700/40 last:border-0 hover:bg-slate-800/40 cursor-pointer transition-colors"
                        onClick={() => setActivePanel(tool.id)}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="p-1.5 bg-amber-900/30 rounded">
                              <Wrench className="w-3.5 h-3.5 text-amber-400" />
                            </div>
                            <div>
                              <p className="font-medium text-white">{tool.name}</p>
                              {tool.description && (
                                <p className="text-xs text-slate-500 truncate max-w-[200px]">{tool.description}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <code className="text-xs text-slate-400 bg-slate-700/60 px-1.5 py-0.5 rounded">{tool.slug}</code>
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <div className="flex flex-wrap gap-1">
                            {tags.map(tag => (
                              <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-blue-900/30 border border-blue-700/40 text-blue-300">
                                {tag}
                              </span>
                            ))}
                            {tags.length === 0 && <span className="text-xs text-slate-600">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <span className="text-xs text-slate-400">{tool.permissions || '—'}</span>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className="text-xs text-slate-400 font-mono">{tool.implementation_type}</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={e => handleToggleEnabled(tool, e)}
                            className="transition-colors"
                            title={tool.enabled ? 'Disable tool' : 'Enable tool'}
                          >
                            {tool.enabled
                              ? <ToggleRight className="w-5 h-5 text-emerald-400" />
                              : <ToggleLeft className="w-5 h-5 text-slate-600" />
                            }
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <ChevronRight className="w-4 h-4 text-slate-600" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Servers sub-section
// ---------------------------------------------------------------------------
type McpDetailPanel = 'new' | number | null;

function McpSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activePanel, setActivePanel] = useState<McpDetailPanel>(null);

  const loadServers = useCallback(() => {
    setLoading(true);
    api.getMcpServers()
      .then(setServers)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadServers(); }, [loadServers]);

  const handleToggleEnabled = async (server: McpServer, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.updateMcpServer(server.id, { enabled: server.enabled ? 0 : 1 });
      setServers(prev => prev.map(s => s.id === server.id ? { ...s, enabled: server.enabled ? 0 : 1 } : s));
    } catch (err) {
      alert(`Failed to toggle MCP server: ${err}`);
    }
  };

  const filtered = servers.filter(server =>
    !search
    || server.name.toLowerCase().includes(search.toLowerCase())
    || server.slug.toLowerCase().includes(search.toLowerCase())
    || server.description.toLowerCase().includes(search.toLowerCase())
  );

  if (activePanel !== null) {
    return (
      <McpEditor
        serverId={activePanel === 'new' ? null : activePanel}
        onClose={() => setActivePanel(null)}
        onSaved={() => { setActivePanel(null); loadServers(); }}
        onDeleted={() => { setActivePanel(null); loadServers(); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm">{servers.length} MCP server{servers.length !== 1 ? 's' : ''} registered</p>
        <Button variant="primary" size="sm" onClick={() => setActivePanel('new')}>
          <Plus className="w-4 h-4" /> New MCP Server
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-4 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
          placeholder="Search MCP servers…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {loading && (
        <div className="flex items-center justify-center h-48">
          <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
      )}

      {!loading && !error && (
        filtered.length === 0 ? (
          <Card>
            <div className="text-center py-12 text-slate-500">
              {search ? `No MCP servers matching "${search}"` : 'No MCP servers registered yet'}
            </div>
          </Card>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-700/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/60 bg-slate-800/40">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide hidden md:table-cell">Slug</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide hidden lg:table-cell">Command</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide hidden md:table-cell">Transport</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">Enabled</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(server => (
                  <tr
                    key={server.id}
                    className="border-b border-slate-700/40 last:border-0 hover:bg-slate-800/40 cursor-pointer transition-colors"
                    onClick={() => setActivePanel(server.id)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-cyan-900/30 rounded">
                          <Server className="w-3.5 h-3.5 text-cyan-400" />
                        </div>
                        <div>
                          <p className="font-medium text-white">{server.name}</p>
                          {server.description && (
                            <p className="text-xs text-slate-500 truncate max-w-[280px]">{server.description}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <code className="text-xs text-slate-400 bg-slate-700/60 px-1.5 py-0.5 rounded">{server.slug}</code>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <code className="text-xs text-slate-400">{server.command}</code>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-xs text-slate-400 font-mono">{server.transport}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={e => handleToggleEnabled(server, e)}
                        className="transition-colors"
                        title={server.enabled ? 'Disable MCP server' : 'Enable MCP server'}
                      >
                        {server.enabled
                          ? <ToggleRight className="w-5 h-5 text-emerald-400" />
                          : <ToggleLeft className="w-5 h-5 text-slate-600" />
                        }
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChevronRight className="w-4 h-4 text-slate-600" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool Editor panel (create / edit)
// ---------------------------------------------------------------------------
interface ToolEditorProps {
  toolId: number | null; // null = new tool
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

function ToolEditor({ toolId, onClose, onSaved, onDeleted }: ToolEditorProps) {
  const isNew = toolId === null;
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Assigned agents
  const [assignedAgents, setAssignedAgents] = useState<{ agent_id: number; name?: string }[]>([]);

  // Form fields
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [implType, setImplType] = useState<'bash' | 'mcp' | 'function'>('bash');
  const [implBody, setImplBody] = useState('');
  const [inputSchema, setInputSchema] = useState('{}');
  const [permissions, setPermissions] = useState('read_only');
  const [tagsInput, setTagsInput] = useState('');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (isNew) return;
    api.getTool(toolId!)
      .then(t => {
        setName(t.name);
        setSlug(t.slug);
        setDescription(t.description || '');
        setImplType(t.implementation_type);
        setImplBody(t.implementation_body || '');
        setInputSchema(t.input_schema || '{}');
        setPermissions(t.permissions || 'read_only');
        let tags: string[] = [];
        try { tags = JSON.parse(t.tags); } catch {}
        setTagsInput(tags.join(', '));
        setEnabled(!!t.enabled);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [toolId, isNew]);

  const parseTags = () =>
    tagsInput.split(',').map(t => t.trim()).filter(Boolean);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const data = {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
        implementation_type: implType,
        implementation_body: implBody,
        input_schema: inputSchema,
        permissions,
        tags: parseTags() as unknown as string,
        enabled: enabled ? 1 : 0,
      };
      if (isNew) {
        await api.createTool(data);
      } else {
        await api.updateTool(toolId!, data);
      }
      onSaved();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteTool(toolId!);
      onDeleted();
    } catch (e) {
      setDeleteError(String(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-48">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
          <h2 className="text-lg font-semibold text-white">
            {isNew ? 'New Tool' : `Edit: ${name}`}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {!isNew && (
            confirmDelete ? (
              <>
                <span className="text-xs text-red-400">Disable this tool?</span>
                <Button variant="danger" size="sm" onClick={handleDelete} loading={deleting}>
                  <Trash2 className="w-3.5 h-3.5" /> Yes, disable
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="w-3.5 h-3.5" /> Disable
              </Button>
            )
          )}
          <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
            <Check className="w-3.5 h-3.5" /> Save
          </Button>
        </div>
      </div>

      {deleteError && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">{deleteError}</div>
      )}

      {/* Form */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Name *</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Execute Bash Script"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Slug *</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
              value={slug}
              onChange={e => setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, ''))}
              placeholder="execute_bash"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">Description</label>
            <textarea
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 resize-none"
              rows={2}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Brief description of what this tool does"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Implementation Type *</label>
            <select
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
              value={implType}
              onChange={e => setImplType(e.target.value as 'bash' | 'mcp' | 'function')}
            >
              <option value="bash">bash</option>
              <option value="mcp">mcp</option>
              <option value="function">function</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Permissions</label>
            <select
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
              value={permissions}
              onChange={e => setPermissions(e.target.value)}
            >
              <option value="read_only">read_only</option>
              <option value="read_write">read_write</option>
              <option value="admin">admin</option>
              <option value="network">network</option>
              <option value="execute">execute</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Tags <span className="text-slate-600">(comma-separated)</span></label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="git, filesystem, network"
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-slate-400">Enabled</label>
            <button onClick={() => setEnabled(v => !v)} className="transition-colors">
              {enabled
                ? <ToggleRight className="w-6 h-6 text-emerald-400" />
                : <ToggleLeft className="w-6 h-6 text-slate-600" />
              }
            </button>
          </div>
        </div>
      </Card>

      {/* Implementation body */}
      <Card>
        <label className="block text-xs text-slate-400 mb-2">Implementation Body</label>
        <textarea
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-amber-500 resize-y"
          rows={10}
          value={implBody}
          onChange={e => setImplBody(e.target.value)}
          spellCheck={false}
          placeholder={implType === 'bash' ? '#!/bin/bash\n# your script here' : implType === 'function' ? 'async function run(args) {\n  // ...\n}' : '# MCP config'}
        />
      </Card>

      {/* Input schema */}
      <Card>
        <label className="block text-xs text-slate-400 mb-2">Input Schema <span className="text-slate-600">(JSON)</span></label>
        <textarea
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-amber-500 resize-y"
          rows={6}
          value={inputSchema}
          onChange={e => setInputSchema(e.target.value)}
          spellCheck={false}
          placeholder='{"type":"object","properties":{}}'
        />
      </Card>

      {saveError && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">{saveError}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Editor panel (create / edit)
// ---------------------------------------------------------------------------
interface McpEditorProps {
  serverId: number | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

function McpEditor({ serverId, onClose, onSaved, onDeleted }: McpEditorProps) {
  const isNew = serverId === null;
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('[]');
  const [env, setEnv] = useState('{}');
  const [cwd, setCwd] = useState('');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (isNew) return;
    api.getMcpServer(serverId!)
      .then(server => {
        setName(server.name);
        setSlug(server.slug);
        setDescription(server.description || '');
        setCommand(server.command || '');
        setArgs(server.args || '[]');
        setEnv(server.env || '{}');
        setCwd(server.cwd || '');
        setEnabled(!!server.enabled);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [isNew, serverId]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const data = {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
        transport: 'stdio' as const,
        command: command.trim(),
        args,
        env,
        cwd: cwd.trim() || null,
        enabled: enabled ? 1 : 0,
      };
      if (isNew) {
        await api.createMcpServer(data);
      } else {
        await api.updateMcpServer(serverId!, data);
      }
      onSaved();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteMcpServer(serverId!);
      onDeleted();
    } catch (e) {
      setDeleteError(String(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-48">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
          <h2 className="text-lg font-semibold text-white">
            {isNew ? 'New MCP Server' : `Edit: ${name}`}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {!isNew && (
            confirmDelete ? (
              <>
                <span className="text-xs text-red-400">Confirm delete?</span>
                <Button variant="danger" size="sm" onClick={handleDelete} loading={deleting}>
                  <Trash2 className="w-3.5 h-3.5" /> Yes, delete
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </Button>
            )
          )}
          <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
            <Check className="w-3.5 h-3.5" /> Save
          </Button>
        </div>
      </div>

      {deleteError && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">{deleteError}</div>
      )}

      <Card>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Name *</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Agent HQ MCP Server"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Slug *</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
              value={slug}
              onChange={e => setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, ''))}
              placeholder="agent-hq"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">Description</label>
            <textarea
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 resize-none"
              rows={2}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What this MCP server exposes"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Transport</label>
            <input
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-400 text-sm"
              value="stdio"
              disabled
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-slate-400">Enabled</label>
            <button onClick={() => setEnabled(v => !v)} className="transition-colors">
              {enabled
                ? <ToggleRight className="w-6 h-6 text-emerald-400" />
                : <ToggleLeft className="w-6 h-6 text-slate-600" />
              }
            </button>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">Command *</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder="/opt/homebrew/bin/node"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">Working Directory</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
              value={cwd}
              onChange={e => setCwd(e.target.value)}
              placeholder="/path/to/agent-hq"
            />
          </div>
        </div>
      </Card>

      <Card>
        <label className="block text-xs text-slate-400 mb-2">Args <span className="text-slate-600">(JSON array)</span></label>
        <textarea
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-amber-500 resize-y"
          rows={5}
          value={args}
          onChange={e => setArgs(e.target.value)}
          spellCheck={false}
          placeholder='["/path/to/agent-hq/api/dist/mcp/server.js"]'
        />
      </Card>

      <Card>
        <label className="block text-xs text-slate-400 mb-2">Env <span className="text-slate-600">(JSON object)</span></label>
        <textarea
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-amber-500 resize-y"
          rows={6}
          value={env}
          onChange={e => setEnv(e.target.value)}
          spellCheck={false}
          placeholder='{"AGENT_HQ_API_URL":"http://127.0.0.1:3501"}'
        />
      </Card>

      {saveError && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">{saveError}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Capabilities page
// ---------------------------------------------------------------------------
export default function CapabilitiesPage() {
  const [subTab, setSubTab] = useState<SubTab>('skills');

  return (
    <div className="space-y-6" data-tour-target="capabilities-main">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Capabilities</h1>
        <p className="text-slate-400 text-sm mt-1">Skills, tools, and MCP servers available to agents</p>
      </div>

      {/* Sub-tab toggle */}
      <div className="flex items-center gap-1 bg-slate-800/60 border border-slate-700/60 rounded-xl p-1 w-fit">
        <button
          onClick={() => setSubTab('skills')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            subTab === 'skills'
              ? 'bg-violet-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          Skills
        </button>
        <button
          onClick={() => setSubTab('tools')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            subTab === 'tools'
              ? 'bg-amber-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          <Wrench className="w-4 h-4" />
          Tools
        </button>
        <button
          onClick={() => setSubTab('mcp')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            subTab === 'mcp'
              ? 'bg-cyan-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          <Server className="w-4 h-4" />
          MCP
        </button>
      </div>

      {/* Sub-tab content */}
      {subTab === 'skills' ? <SkillsSection /> : subTab === 'tools' ? <ToolsSection /> : <McpSection />}
    </div>
  );
}
