'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { api, getApiBase, ArtifactTreeNode, ArtifactFile, Agent, Project } from '@/lib/api';
import { findAtlasAgent, isAtlasAgent } from '@/lib/atlas';
import { getFileTypeStyle } from '@/lib/file-type-colors';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import SyntaxHighlighter from '@/components/SyntaxHighlighter';
import {
  Folder,
  FolderOpen,
  FileText,
  File,
  Files,
  ImageIcon,
  ChevronRight,
  ChevronDown,
  Save,
  Trash2,
  Plus,
  ArrowLeft,
  RefreshCw,
  Eye,
  Pencil,
  Bot,
  Filter,
} from 'lucide-react';

const ChevronDownSm = ChevronDown;

// ─── Image extensions ─────────────────────────────────────────────────────────
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'tif']);

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(name));
}

const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'sh', 'bash', 'zsh', 'fish',
  'css', 'scss', 'html', 'htm', 'xml', 'svg',
  'sql', 'graphql', 'prisma',
  'gitignore', 'gitattributes', 'editorconfig', 'dockerignore',
  'Dockerfile', 'Makefile', 'lock', 'log',
  'rs', 'go', 'rb', 'php', 'java', 'kt', 'swift', 'c', 'cpp', 'h',
]);

function getExtension(name: string): string {
  const parts = name.split('.');
  if (parts.length <= 1) return name;
  return parts[parts.length - 1].toLowerCase();
}

function isTextFile(name: string): boolean {
  const ext = getExtension(name);
  return TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(name);
}

function isMarkdown(name: string): boolean {
  const ext = getExtension(name);
  return ext === 'md' || ext === 'mdx';
}

function getFileIcon(name: string, isDir: boolean) {
  if (isDir) return null;
  const style = getFileTypeStyle(name);
  const ext = getExtension(name);
  if (IMAGE_EXTENSIONS.has(ext)) return <ImageIcon className={`w-3.5 h-3.5 ${style.iconColor} shrink-0`} />;
  if (isTextFile(name)) return <FileText className={`w-3.5 h-3.5 ${style.iconColor} shrink-0`} />;
  return <File className={`w-3.5 h-3.5 ${style.iconColor} shrink-0`} />;
}

function isArtifactTreeNode(value: unknown): value is ArtifactTreeNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Partial<ArtifactTreeNode>;
  if (typeof node.name !== 'string') return false;
  if (typeof node.path !== 'string') return false;
  if (node.type !== 'file' && node.type !== 'dir') return false;
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) return false;
    if (!node.children.every(child => isArtifactTreeNode(child))) return false;
  }
  return true;
}

function normalizeArtifactTreePayload(data: unknown): { root: string; children: ArtifactTreeNode[] } {
  if (!data || typeof data !== 'object') {
    throw new Error('Workspace tree response was not an object');
  }

  const payload = data as { root?: unknown; children?: unknown };
  if (typeof payload.root !== 'string') {
    throw new Error('Workspace tree response is missing a valid root');
  }
  if (!Array.isArray(payload.children)) {
    throw new Error('Workspace tree response is missing a valid children array');
  }
  if (!payload.children.every(child => isArtifactTreeNode(child))) {
    throw new Error('Workspace tree response contained invalid tree nodes');
  }

  return {
    root: payload.root,
    children: payload.children,
  };
}

// ─── Tree Node Component ──────────────────────────────────────────────────────
function TreeNodeItem({
  node,
  depth,
  selectedPath,
  expandedDirs,
  renamingPath,
  renameValue,
  onSelect,
  onToggleDir,
  onDelete,
  onRenameStart,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
}: {
  node: ArtifactTreeNode;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  renamingPath: string | null;
  renameValue: string;
  onSelect: (path: string) => void;
  onToggleDir: (path: string) => void;
  onDelete: (path: string, name: string, isDir: boolean) => void;
  onRenameStart: (path: string, name: string) => void;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
}) {
  const isDir = node.type === 'dir';
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;
  const isRenaming = renamingPath === node.path;
  const [hover, setHover] = useState(false);
  const fileStyle = getFileTypeStyle(node.name, isDir);

  const indent = depth * 12;

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-0.5 pr-2 rounded cursor-pointer select-none group text-xs
          ${isSelected ? 'bg-amber-500/20' : 'hover:bg-slate-700/50'}
        `}
        style={{ paddingLeft: `${indent + 6}px` }}
        onClick={() => {
          if (isRenaming) return;
          if (isDir) onToggleDir(node.path);
          else onSelect(node.path);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <span className="w-3 h-3 shrink-0 flex items-center justify-center">
          {isDir && (
            isExpanded
              ? <ChevronDown className="w-3 h-3 text-slate-400" />
              : <ChevronRight className="w-3 h-3 text-slate-500" />
          )}
        </span>

        {isDir
          ? (isExpanded
            ? <FolderOpen className={`w-3.5 h-3.5 ${fileStyle.iconColor} shrink-0`} />
            : <Folder className={`w-3.5 h-3.5 ${fileStyle.iconColor} opacity-70 shrink-0`} />)
          : getFileIcon(node.name, false)}

        {isRenaming ? (
          <input
            className="flex-1 min-w-0 bg-slate-700 border border-amber-500/50 rounded px-1 py-0 text-xs text-white font-mono focus:outline-none"
            value={renameValue}
            onChange={e => onRenameChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onRenameSubmit();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onBlur={onRenameCancel}
            onClick={e => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span className={`flex-1 truncate min-w-0 ${isSelected ? 'text-amber-200' : fileStyle.nameColor}`}>{node.name}</span>
        )}

        {hover && !isRenaming && !isDir && (
          <button
            onClick={e => { e.stopPropagation(); onRenameStart(node.path, node.name); }}
            className="p-0.5 rounded text-slate-600 hover:text-amber-400 transition-colors shrink-0"
            title={`Rename ${node.name}`}
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
        {hover && !isRenaming && (
          <button
            onClick={e => { e.stopPropagation(); onDelete(node.path, node.name, isDir); }}
            className="p-0.5 rounded text-slate-600 hover:text-red-400 transition-colors shrink-0"
            title={`Delete ${node.name}`}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {isDir && isExpanded && node.children && (
        <div>
          {node.children.map(child => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedDirs={expandedDirs}
              renamingPath={renamingPath}
              renameValue={renameValue}
              onSelect={onSelect}
              onToggleDir={onToggleDir}
              onDelete={onDelete}
              onRenameStart={onRenameStart}
              onRenameChange={onRenameChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
            />
          ))}
          {node.children.length === 0 && (
            <div
              className="text-slate-600 text-xs py-0.5"
              style={{ paddingLeft: `${(depth + 2) * 12 + 6}px` }}
            >
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Project Filter ───────────────────────────────────────────────────────────
function ProjectFilter({
  projects,
  selectedProjectId,
  onSelect,
}: {
  projects: Project[];
  selectedProjectId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = selectedProjectId ? projects.find(p => p.id === selectedProjectId) : null;
  const label = selected ? selected.name : 'All Projects';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm hover:bg-slate-700 transition-colors ${
          selectedProjectId
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
            : 'bg-slate-700/60 border-slate-600 text-white'
        }`}
      >
        <Filter className="w-3.5 h-3.5 text-slate-400" />
        {label}
        <ChevronDownSm className="w-3.5 h-3.5 text-slate-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded-xl shadow-xl z-20 min-w-[200px] py-1 max-h-64 overflow-y-auto">
          <button
            onClick={() => { onSelect(null); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-700/60 transition-colors flex items-center gap-2 ${!selectedProjectId ? 'text-amber-300' : 'text-slate-300'}`}
          >
            All Projects
          </button>
          {projects.map(project => (
            <button
              key={project.id}
              onClick={() => { onSelect(project.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-700/60 transition-colors flex items-center gap-2 ${selectedProjectId === project.id ? 'text-amber-300' : 'text-slate-300'}`}
            >
              {project.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Agent Selector ───────────────────────────────────────────────────────────
function AgentSelector({
  agents,
  selectedAgentId,
  onSelect,
}: {
  agents: Agent[];
  selectedAgentId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const atlasAgent = findAtlasAgent(agents);
  const selected = selectedAgentId ? agents.find(a => a.id === selectedAgentId) : atlasAgent;
  const label = selected ? selected.name : 'Atlas';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 bg-slate-700/60 border border-slate-600 rounded-lg text-sm text-white hover:bg-slate-700 transition-colors"
      >
        <Bot className="w-3.5 h-3.5 text-amber-400" />
        {label}
        <ChevronDownSm className="w-3.5 h-3.5 text-slate-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded-xl shadow-xl z-20 min-w-[200px] py-1">
          <button
            onClick={() => { onSelect(null); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-700/60 transition-colors flex items-center gap-2 ${!selectedAgentId ? 'text-amber-300' : 'text-slate-300'}`}
          >
            <Bot className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            Atlas
          </button>
          {agents.filter(agent => !isAtlasAgent(agent)).map(agent => (
            <button
              key={agent.id}
              onClick={() => { onSelect(agent.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-700/60 transition-colors flex items-center gap-2 ${selectedAgentId === agent.id ? 'text-amber-300' : 'text-slate-300'}`}
            >
              <Bot className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              {agent.name}
              {agent.openclaw_agent_id && (
                <span className="text-xs text-slate-500 ml-auto font-mono">{agent.openclaw_agent_id}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function WorkspacesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProjectId, setSelectedProjectId] = useProjectFilterPreference({ validProjectIds });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);

  const [tree, setTree] = useState<ArtifactTreeNode[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileData, setFileData] = useState<ArtifactFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [editContent, setEditContent] = useState<string>('');
  const [isDirty, setIsDirty] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'edit'>('edit');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [mobilePanel, setMobilePanel] = useState<'tree' | 'editor'>('tree');

  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [creatingFile, setCreatingFile] = useState(false);

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Load projects on mount
  useEffect(() => {
    api.getProjects().then(setProjects).catch(console.error);
  }, []);

  // Load agents (filtered by project when selected)
  useEffect(() => {
    api.getAgents(selectedProjectId).then(setAgents).catch(console.error);
  }, [selectedProjectId]);

  const loadTree = useCallback(() => {
    setTreeLoading(true);
    setTreeError(null);
    setSelectedPath(null);
    setFileData(null);
    setExpandedDirs(new Set());
    api.getArtifactTree(selectedAgentId ?? undefined)
      .then(data => {
        const normalized = normalizeArtifactTreePayload(data);
        setTree(normalized.children);
        setWorkspaceRoot(normalized.root);
      })
      .catch(e => {
        setTree([]);
        setWorkspaceRoot('');
        setTreeError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setTreeLoading(false));
  }, [selectedAgentId]);

  useEffect(() => { loadTree(); }, [loadTree]);

  const handleSelectFile = useCallback(async (path: string) => {
    setSelectedPath(path);
    setFileLoading(true);
    setFileError(null);
    setIsDirty(false);
    setSaveError(null);
    setMobilePanel('editor');

    try {
      const data = await api.getArtifactFile(path, selectedAgentId ?? undefined);
      setFileData(data);
      setEditContent(data.content ?? '');
      setViewMode(isTextFile(path.split('/').pop() ?? '') ? 'preview' : 'edit');
    } catch (e) {
      setFileError(String(e));
      setFileData(null);
    } finally {
      setFileLoading(false);
    }
  }, [selectedAgentId]);

  const handleToggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleContentChange = (val: string) => {
    setEditContent(val);
    setIsDirty(val !== (fileData?.content ?? ''));
  };

  const handleSave = async () => {
    if (!selectedPath) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveArtifactFile(selectedPath, editContent, selectedAgentId ?? undefined);
      setFileData(prev => prev ? { ...prev, content: editContent } : prev);
      setIsDirty(false);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (path: string, name: string, isDir: boolean) => {
    if (!confirm(`Delete "${name}"?${isDir ? ' This will delete the entire directory.' : ''}`)) return;
    try {
      await api.deleteArtifact(path, selectedAgentId ?? undefined);
      if (selectedPath === path || (isDir && selectedPath?.startsWith(path + '/'))) {
        setSelectedPath(null);
        setFileData(null);
      }
      loadTree();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;
    setCreatingFile(true);
    try {
      const path = newFileName.trim();
      await api.saveArtifactFile(path, '', selectedAgentId ?? undefined);
      setNewFileName('');
      setShowNewFile(false);
      loadTree();
      await handleSelectFile(path);
    } catch (e) {
      alert(String(e));
    } finally {
      setCreatingFile(false);
    }
  };

  const handleProjectSelect = (id: number | null) => {
    setSelectedProjectId(id);
    // Reset agent selection when project filter changes — the previously
    // selected agent may not belong to the new project.
    setSelectedAgentId(null);
  };

  const handleRenameStart = (filePath: string, name: string) => {
    setRenamingPath(filePath);
    setRenameValue(name);
  };

  const handleRenameSubmit = async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    const newName = renameValue.trim();
    const parts = renamingPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    if (newPath === renamingPath) {
      setRenamingPath(null);
      return;
    }
    try {
      await api.renameArtifact(renamingPath, newPath, selectedAgentId ?? undefined);
      if (selectedPath === renamingPath) {
        setSelectedPath(newPath);
      }
      setRenamingPath(null);
      loadTree();
    } catch (e) {
      alert(String(e));
      setRenamingPath(null);
    }
  };

  const handleRenameCancel = () => {
    setRenamingPath(null);
  };

  const handleAgentSelect = (id: number | null) => {
    setSelectedAgentId(id);
  };

  const breadcrumb = selectedPath ? selectedPath.split('/') : [];

  // Resolve raw image URL for current agent
  const getRawUrl = (path: string) => {
    const agentQs = selectedAgentId ? `&agentId=${selectedAgentId}` : '';
    return `${getApiBase()}/api/v1/artifacts/raw?path=${encodeURIComponent(path)}${agentQs}`;
  };

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 'calc(100vh - 3rem)' }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Files className="w-5 h-5 text-amber-400" />
          <h1 className="text-xl font-bold text-white">Workspaces</h1>
          <span className="text-slate-500 text-sm hidden sm:block">Agent workspace files</span>
        </div>
        <div className="flex items-center gap-2">
          <ProjectFilter
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelect={handleProjectSelect}
          />
          <AgentSelector
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSelect={handleAgentSelect}
          />
          <Button variant="ghost" size="sm" onClick={loadTree} title="Refresh tree">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <Button variant="primary" size="sm" onClick={() => { setShowNewFile(true); setNewFileName(''); }}>
            <Plus className="w-3.5 h-3.5" /> New File
          </Button>
        </div>
      </div>

      {showNewFile && (
        <div className="mb-4 bg-slate-800/60 border border-amber-500/30 rounded-xl p-4">
          <p className="text-slate-300 text-sm mb-2 font-medium">New file path (relative to workspace root)</p>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
              value={newFileName}
              onChange={e => setNewFileName(e.target.value)}
              placeholder="notes/my-file.md"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCreateFile()}
            />
            <Button variant="primary" size="sm" onClick={handleCreateFile} loading={creatingFile}>
              Create
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowNewFile(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {selectedPath && (
        <div className="flex gap-2 mb-3 md:hidden">
          <Button
            variant={mobilePanel === 'tree' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMobilePanel('tree')}
          >
            <Folder className="w-3.5 h-3.5" /> Files
          </Button>
          <Button
            variant={mobilePanel === 'editor' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMobilePanel('editor')}
          >
            <FileText className="w-3.5 h-3.5" /> Editor
          </Button>
        </div>
      )}

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: File Tree */}
        <div
          className={`
            bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden flex flex-col
            ${selectedPath ? (mobilePanel === 'tree' ? 'flex md:flex' : 'hidden md:flex') : 'flex'}
            md:w-72 w-full shrink-0
          `}
          style={{ maxHeight: 'calc(100vh - 200px)', minHeight: '400px' }}
        >
          <div className="px-3 py-2 border-b border-slate-700/50">
            <p className="text-slate-500 text-xs font-mono truncate">{workspaceRoot || 'Loading...'}</p>
          </div>
          <div className="overflow-y-auto flex-1 py-1">
            {treeLoading ? (
              <div className="flex items-center justify-center h-20">
                <div className="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : treeError ? (
              <div className="px-3 py-2 text-red-400 text-xs">{treeError}</div>
            ) : tree.length === 0 ? (
              <div className="px-3 py-2 text-slate-500 text-xs">Empty workspace</div>
            ) : (
              tree.map(node => (
                <TreeNodeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  renamingPath={renamingPath}
                  renameValue={renameValue}
                  onSelect={handleSelectFile}
                  onToggleDir={handleToggleDir}
                  onDelete={handleDelete}
                  onRenameStart={handleRenameStart}
                  onRenameChange={setRenameValue}
                  onRenameSubmit={handleRenameSubmit}
                  onRenameCancel={handleRenameCancel}
                />
              ))
            )}
          </div>
        </div>

        {/* Right: File Viewer / Editor */}
        <div
          className={`
            flex-1 min-w-0 bg-slate-800/60 border border-slate-700/50 rounded-xl flex flex-col overflow-hidden
            ${selectedPath ? (mobilePanel === 'editor' ? 'flex' : 'hidden md:flex') : 'flex'}
          `}
          style={{ maxHeight: 'calc(100vh - 200px)', minHeight: '400px' }}
        >
          {!selectedPath ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-2">
                <Files className="w-10 h-10 text-slate-700 mx-auto" />
                <p className="text-slate-500 text-sm">Select a file to view</p>
              </div>
            </div>
          ) : (
            <>
              <div className="px-4 py-2.5 border-b border-slate-700/50 flex items-center gap-2 shrink-0">
                <button
                  className="md:hidden p-1 rounded text-slate-400 hover:text-white"
                  onClick={() => setMobilePanel('tree')}
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>

                <div className="flex-1 flex items-center gap-1 text-xs text-slate-400 min-w-0 overflow-hidden">
                  {breadcrumb.map((part, i) => (
                    <span key={i} className="flex items-center gap-1 min-w-0">
                      {i > 0 && <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />}
                      <span className={i === breadcrumb.length - 1 ? 'text-white font-medium truncate' : 'text-slate-500 truncate'}>
                        {part}
                      </span>
                    </span>
                  ))}
                  {isDirty && <span className="w-1.5 h-1.5 bg-amber-400 rounded-full shrink-0 ml-1" title="Unsaved changes" />}
                </div>

                {fileData && !fileData.binary && (
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => setViewMode('preview')}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors flex items-center gap-1 ${
                        viewMode === 'preview'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      <Eye className="w-3 h-3" /> View
                    </button>
                    <button
                      onClick={() => setViewMode('edit')}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors flex items-center gap-1 ${
                        viewMode === 'edit'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                  </div>
                )}

                {fileData && !fileData.binary && viewMode === 'edit' && isDirty && (
                  <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                    <Save className="w-3 h-3" /> Save
                  </Button>
                )}
              </div>

              <div className="flex-1 overflow-auto">
                {fileLoading ? (
                  <div className="flex items-center justify-center h-32">
                    <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : fileError ? (
                  <div className="p-4 text-red-400 text-sm">{fileError}</div>
                ) : !fileData ? null : fileData.binary ? (
                  isImageFile(selectedPath.split('/').pop() ?? '') ? (
                    <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={getRawUrl(selectedPath)}
                        alt={selectedPath.split('/').pop()}
                        className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
                        style={{ maxHeight: 'calc(100vh - 280px)' }}
                      />
                    </div>
                  ) : (
                    <div className="p-4 text-slate-500 text-sm italic">Binary file — preview not available</div>
                  )
                ) : !isTextFile(selectedPath.split('/').pop() ?? '') && fileData.content === null ? (
                  <div className="p-4 text-slate-500 text-sm italic">Cannot display this file type</div>
                ) : viewMode === 'preview' && isMarkdown(selectedPath) ? (
                  <div className="p-4 prose prose-invert prose-sm max-w-none
                    prose-headings:text-white prose-p:text-slate-300 prose-code:text-amber-300
                    prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700
                    prose-a:text-amber-400 prose-strong:text-white prose-li:text-slate-300
                    prose-table:text-slate-300 prose-th:text-white prose-hr:border-slate-700
                  ">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {editContent}
                    </ReactMarkdown>
                  </div>
                ) : viewMode === 'preview' ? (
                  <SyntaxHighlighter
                    code={editContent}
                    filename={selectedPath.split('/').pop() ?? ''}
                  />
                ) : (
                  <textarea
                    className="w-full h-full min-h-full bg-transparent text-slate-200 text-xs font-mono p-4 resize-none focus:outline-none"
                    style={{ minHeight: '400px' }}
                    value={editContent}
                    onChange={e => handleContentChange(e.target.value)}
                    spellCheck={false}
                  />
                )}
              </div>

              {(fileData || saveError) && (
                <div className="px-4 py-1.5 border-t border-slate-700/50 flex items-center gap-3 text-xs text-slate-600 shrink-0">
                  {fileData?.size !== undefined && (
                    <span>{(fileData.size / 1024).toFixed(1)} KB</span>
                  )}
                  {fileData?.modified && (
                    <span>Modified {new Date(fileData.modified).toLocaleString()}</span>
                  )}
                  {saveError && <span className="text-red-400 ml-auto">{saveError}</span>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
