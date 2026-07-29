/**
 * workspaceProvider.ts — Workspace provider abstraction for local and remote agents.
 *
 * Provider interface:
 *   - readDocs(filenames)  → identity doc contents
 *   - tree(depth)          → workspace file tree
 *   - readFile(relPath)    → file content + metadata
 *   - writeFile(relPath, content) → write result
 *   - deleteFile(relPath)  → delete result
 *   - mkdir(relPath)       → create directory
 *   - rename(oldPath, newPath) → rename/move
 *   - rawFile(relPath)     → { mime, stream|buffer } for binary serving
 *
 * Factory:
 *   resolveWorkspaceProvider(agentId?) → WorkspaceProvider
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { getDb } from '../db/client';
import { WORKSPACE_ROOT as DEFAULT_WORKSPACE_ROOT } from '../config';
import { ATLAS_SYSTEM_ROLE } from './atlasAgent';
import { resolveAtlasWorkspaceRoot } from './atlasAgent';

// ── Public types ──────────────────────────────────────────────────────────────

export interface DocResult {
  filename: string;
  content: string | null;
  exists: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
  size?: number;
  modified?: string;
}

export interface FileReadResult {
  path: string;
  size?: number;
  modified?: string;
  content: string | null;
  binary: boolean;
}

export interface FileWriteResult {
  ok: boolean;
  path: string;
  size?: number;
  modified?: string;
}

export interface RawFileResult {
  mime: string;
  size?: number;
  /** For local files — a readable stream. For remote — a Buffer or string. */
  stream?: Readable;
  buffer?: Buffer | string;
}

export interface WorkspaceProvider {
  /** Human-readable root identifier (local path or remote URL) */
  readonly root: string;

  /** Whether this provider is backed by a remote API */
  readonly isRemote: boolean;

  /** Read well-known identity/config docs from the workspace */
  readDocs(filenames: string[]): Promise<DocResult[]>;

  /** Get the workspace file tree up to `depth` levels */
  tree(depth?: number): Promise<{ root: string; children: TreeNode[] }>;

  /** Read a single file */
  readFile(relPath: string): Promise<FileReadResult>;

  /** Write/create a file */
  writeFile(relPath: string, content: string): Promise<FileWriteResult>;

  /** Delete a file or directory */
  deleteFile(relPath: string): Promise<{ ok: boolean; path: string }>;

  /** Create a directory */
  mkdir(relPath: string): Promise<{ ok: boolean; path: string; note?: string }>;

  /** Rename/move a file */
  rename(oldPath: string, newPath: string): Promise<{ ok: boolean; oldPath: string; newPath: string }>;

  /** Get raw file content for streaming (images, binaries) */
  rawFile(relPath: string): Promise<RawFileResult>;
}

// ── Local filesystem provider ─────────────────────────────────────────────────

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.next', '__pycache__', 'dist']);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'svg',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z',
  'mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'ogg', 'flac',
  'woff', 'woff2', 'ttf', 'eot',
  'db', 'sqlite', 'sqlite3',
  'exe', 'bin', 'dylib', 'so', 'dll',
]);

function isBinaryByExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return BINARY_EXTENSIONS.has(ext);
}

function safePath(relativePath: string, workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    throw new PathTraversalError('Path traversal not allowed');
  }
  return resolved;
}

function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

function buildTree(dirPath: string, relBase: string, depth: number): TreeNode[] {
  if (depth <= 0) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    const name = entry.name;
    const relPath = relBase ? `${relBase}/${name}` : name;
    const fullPath = path.join(dirPath, name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      const children = buildTree(fullPath, relPath, depth - 1);
      nodes.push({ name, path: relPath, type: 'dir', children });
    } else if (entry.isFile()) {
      if (name.endsWith('.pyc')) continue;
      let size: number | undefined;
      let modified: string | undefined;
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
        modified = stat.mtime.toISOString();
      } catch { /* ignore */ }
      nodes.push({ name, path: relPath, type: 'file', size, modified });
    }
  }
  return sortTreeNodes(nodes);
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp', tiff: 'image/tiff',
  tif: 'image/tiff', pdf: 'application/pdf',
};

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly root: string;
  readonly isRemote = false;

  constructor(workspaceRoot: string) {
    this.root = workspaceRoot;
  }

  async readDocs(filenames: string[]): Promise<DocResult[]> {
    return filenames.map(filename => {
      if (!this.root) {
        return { filename, content: null, exists: false };
      }
      try {
        const filePath = path.join(this.root, filename);
        const content = fs.readFileSync(filePath, 'utf-8');
        return { filename, content, exists: true };
      } catch {
        return { filename, content: null, exists: false };
      }
    });
  }

  async tree(depth = 4): Promise<{ root: string; children: TreeNode[] }> {
    const children = buildTree(this.root, '', depth);
    return { root: this.root, children };
  }

  async readFile(relPath: string): Promise<FileReadResult> {
    const fullPath = safePath(relPath, this.root);
    if (!fs.existsSync(fullPath)) {
      throw new FileNotFoundError(`File not found: ${relPath}`);
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      throw new Error('Path is a directory');
    }
    const meta = { path: relPath, size: stat.size, modified: stat.mtime.toISOString() };
    if (isBinaryByExtension(relPath)) {
      return { ...meta, content: null, binary: true };
    }
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      return { ...meta, content, binary: false };
    } catch {
      return { ...meta, content: null, binary: true };
    }
  }

  async writeFile(relPath: string, content: string): Promise<FileWriteResult> {
    const fullPath = safePath(relPath, this.root);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    const stat = fs.statSync(fullPath);
    return { ok: true, path: relPath, size: stat.size, modified: stat.mtime.toISOString() };
  }

  async deleteFile(relPath: string): Promise<{ ok: boolean; path: string }> {
    const fullPath = safePath(relPath, this.root);
    if (!fs.existsSync(fullPath)) {
      throw new FileNotFoundError(`File not found: ${relPath}`);
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    return { ok: true, path: relPath };
  }

  async mkdir(relPath: string): Promise<{ ok: boolean; path: string }> {
    const fullPath = safePath(relPath, this.root);
    fs.mkdirSync(fullPath, { recursive: true });
    return { ok: true, path: relPath };
  }

  async rename(oldPath: string, newPath: string): Promise<{ ok: boolean; oldPath: string; newPath: string }> {
    const fullOldPath = safePath(oldPath, this.root);
    const fullNewPath = safePath(newPath, this.root);
    if (!fs.existsSync(fullOldPath)) {
      throw new FileNotFoundError(`File not found: ${oldPath}`);
    }
    const newDir = path.dirname(fullNewPath);
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }
    fs.renameSync(fullOldPath, fullNewPath);
    return { ok: true, oldPath, newPath };
  }

  async rawFile(relPath: string): Promise<RawFileResult> {
    const fullPath = safePath(relPath, this.root);
    if (!fs.existsSync(fullPath)) {
      throw new FileNotFoundError(`File not found: ${relPath}`);
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      throw new Error('Path is a directory');
    }
    const ext = path.extname(relPath).toLowerCase().slice(1);
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    return { mime, size: stat.size, stream: fs.createReadStream(fullPath) };
  }
}

export class EmptyWorkspaceProvider implements WorkspaceProvider {
  readonly root = '';
  readonly isRemote = false;

  async readDocs(filenames: string[]): Promise<DocResult[]> {
    return filenames.map(filename => ({ filename, content: null, exists: false }));
  }

  async tree(_depth = 4): Promise<{ root: string; children: TreeNode[] }> {
    return { root: '', children: [] };
  }

  async readFile(relPath: string): Promise<FileReadResult> {
    throw new FileNotFoundError(`File not found: ${relPath}`);
  }

  async writeFile(relPath: string, _content: string): Promise<FileWriteResult> {
    throw new FileNotFoundError(`Workspace not found for: ${relPath}`);
  }

  async deleteFile(relPath: string): Promise<{ ok: boolean; path: string }> {
    throw new FileNotFoundError(`File not found: ${relPath}`);
  }

  async mkdir(relPath: string): Promise<{ ok: boolean; path: string }> {
    throw new FileNotFoundError(`Workspace not found for: ${relPath}`);
  }

  async rename(oldPath: string, _newPath: string): Promise<{ ok: boolean; oldPath: string; newPath: string }> {
    throw new FileNotFoundError(`File not found: ${oldPath}`);
  }

  async rawFile(relPath: string): Promise<RawFileResult> {
    throw new FileNotFoundError(`File not found: ${relPath}`);
  }
}

// ── Remote (API-backed) provider ──────────────────────────────────────────────

interface RemoteConfig {
  baseUrl: string;
  apiKey: string;
}

// Minimal Response type shim for native fetch
type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };

export class RemoteWorkspaceProvider implements WorkspaceProvider {
  readonly root: string;
  readonly isRemote = true;
  private readonly workspaceBase: string;
  private readonly apiKey: string;

  constructor(config: RemoteConfig) {
    this.workspaceBase = config.baseUrl;
    this.apiKey = config.apiKey;
    this.root = config.baseUrl;
  }

  private async fetchJson(urlPath: string, init?: RequestInit): Promise<unknown> {
    const url = `${this.workspaceBase}${urlPath}`;
    let res: FetchResponse;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(init?.headers as Record<string, string> ?? {}),
        },
        signal: AbortSignal.timeout(10_000),
      }) as unknown as FetchResponse;
    } catch (err) {
      throw new RemoteUnavailableError(`Remote workspace unreachable: ${String(err)}`);
    }
    if (res.status === 404) {
      throw new FileNotFoundError(`File not found on remote workspace`);
    }
    if (!res.ok) {
      throw new RemoteUnavailableError(`Remote workspace returned ${res.status}`);
    }
    return res.json();
  }

  async readDocs(filenames: string[]): Promise<DocResult[]> {
    // Read docs individually via the file read endpoint
    const results: DocResult[] = [];
    for (const filename of filenames) {
      try {
        const data = await this.fetchJson(`/files/${filename}`) as Record<string, unknown>;
        results.push({
          filename,
          content: (data.content as string) ?? null,
          exists: data.content != null,
        });
      } catch {
        results.push({ filename, content: null, exists: false });
      }
    }
    return results;
  }

  async tree(_depth?: number): Promise<{ root: string; children: TreeNode[] }> {
    const data = await this.fetchJson('/files');
    return normalizeRemoteTreeResponse(data);
  }

  async readFile(relPath: string): Promise<FileReadResult> {
    const data = await this.fetchJson(`/files/${relPath}`) as Record<string, unknown>;
    return {
      path: (data.path as string) ?? relPath,
      size: data.size as number | undefined,
      modified: data.modified as string | undefined,
      content: (data.content as string) ?? null,
      binary: data.content === null || data.content === undefined,
    };
  }

  async writeFile(relPath: string, content: string): Promise<FileWriteResult> {
    const data = await this.fetchJson(`/files/${relPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }) as Record<string, unknown>;
    return {
      ok: true,
      path: (data.path as string) ?? relPath,
      size: data.size as number | undefined,
      modified: data.modified as string | undefined,
    };
  }

  async deleteFile(relPath: string): Promise<{ ok: boolean; path: string }> {
    await this.fetchJson(`/files/${relPath}`, { method: 'DELETE' });
    return { ok: true, path: relPath };
  }

  async mkdir(relPath: string): Promise<{ ok: boolean; path: string; note?: string }> {
    // Remote workspaces manage their own directories
    return { ok: true, path: relPath, note: 'Remote workspace: directory creation not required' };
  }

  async rename(oldPath: string, newPath: string): Promise<{ ok: boolean; oldPath: string; newPath: string }> {
    // No native rename on remote — emulate via read + write + delete
    const data = await this.readFile(oldPath);
    const content = data.content ?? '';
    await this.writeFile(newPath, content);
    await this.deleteFile(oldPath);
    return { ok: true, oldPath, newPath };
  }

  async rawFile(relPath: string): Promise<RawFileResult> {
    const data = await this.fetchJson(`/files/${relPath}`) as Record<string, unknown>;
    const content = data.content as string | null | undefined;
    if (content == null) {
      throw new FileNotFoundError('File content not available (binary or missing)');
    }
    const ext = path.extname(relPath).toLowerCase().slice(1);
    const mime = MIME_TYPES[ext] ?? 'text/plain; charset=utf-8';
    return { mime, buffer: content };
  }
}

// ── Remote tree normalization ─────────────────────────────────────────────────

interface CustomFileEntry {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  modified?: string;
  mtime?: string;
}

interface CustomTreeResponse {
  active_repo_root?: string;
  repo_root?: string;
  workspace_root?: string;
  root?: string;
  files?: CustomFileEntry[];
  children?: unknown;
}

function normalizeRemoteTreeResponse(data: unknown): { root: string; children: TreeNode[] } {
  const payload = (data && typeof data === 'object' ? data : {}) as CustomTreeResponse;
  const root = typeof payload.active_repo_root === 'string'
    ? payload.active_repo_root
    : typeof payload.repo_root === 'string'
      ? payload.repo_root
      : typeof payload.workspace_root === 'string'
        ? payload.workspace_root
        : typeof payload.root === 'string'
          ? payload.root
          : '/workspace';

  if (Array.isArray(payload.children)) {
    return { root, children: payload.children as TreeNode[] };
  }

  const flatFiles = Array.isArray(payload.files) ? payload.files : [];
  const nodeMap = new Map<string, TreeNode>();

  const ensureDir = (dirPath: string): TreeNode | null => {
    const normalized = dirPath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return null;
    const existing = nodeMap.get(normalized);
    if (existing) {
      if (!existing.children) existing.children = [];
      return existing;
    }
    const parts = normalized.split('/').filter(Boolean);
    const name = parts[parts.length - 1] ?? normalized;
    const node: TreeNode = { name, path: normalized, type: 'dir', children: [] };
    nodeMap.set(normalized, node);
    const parentPath = parts.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);
    if (parent) {
      parent.children = parent.children ?? [];
      if (!parent.children.some(child => child.path === node.path)) {
        parent.children.push(node);
      }
    }
    return node;
  };

  for (const entry of flatFiles) {
    const rawPath = typeof entry.path === 'string' ? entry.path : typeof entry.name === 'string' ? entry.name : '';
    const normalizedPath = rawPath.replace(/^\/+|\/+$/g, '');
    if (!normalizedPath) continue;
    const parts = normalizedPath.split('/').filter(Boolean);
    const name = parts[parts.length - 1] ?? normalizedPath;
    const rawType = typeof entry.type === 'string' ? entry.type : 'file';
    const type: TreeNode['type'] = rawType === 'directory' || rawType === 'dir' ? 'dir' : 'file';
    const parentPath = parts.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);

    if (type === 'dir') {
      const dirNode = ensureDir(normalizedPath);
      if (dirNode && typeof entry.modified === 'string') dirNode.modified = entry.modified;
      if (dirNode && typeof entry.mtime === 'string' && !dirNode.modified) dirNode.modified = entry.mtime;
      continue;
    }

    const node: TreeNode = {
      name,
      path: normalizedPath,
      type: 'file',
      size: typeof entry.size === 'number' ? entry.size : undefined,
      modified: typeof entry.modified === 'string' ? entry.modified : typeof entry.mtime === 'string' ? entry.mtime : undefined,
    };

    if (parent) {
      parent.children = parent.children ?? [];
      if (!parent.children.some(child => child.path === node.path)) {
        parent.children.push(node);
      }
    } else if (!nodeMap.has(node.path)) {
      nodeMap.set(node.path, node);
    }
  }

  const topLevel = Array.from(nodeMap.values()).filter(node => !node.path.includes('/'));
  const sortRecursively = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.children) {
        sortRecursively(node.children);
        sortTreeNodes(node.children);
      }
    }
    sortTreeNodes(nodes);
  };
  sortRecursively(topLevel);
  return { root, children: topLevel };
}

// ── Error types ───────────────────────────────────────────────────────────────

export class PathTraversalError extends Error {
  constructor(msg: string) { super(msg); this.name = 'PathTraversalError'; }
}

export class FileNotFoundError extends Error {
  constructor(msg: string) { super(msg); this.name = 'FileNotFoundError'; }
}

export class RemoteUnavailableError extends Error {
  constructor(msg: string) { super(msg); this.name = 'RemoteUnavailableError'; }
}

// ── Agent row type (minimal) ──────────────────────────────────────────────────

interface AgentRow {
  id: number;
  runtime_type: string | null;
  runtime_config: string | null;
  openclaw_agent_id: string | null;
  workspace_path: string | null;
  [key: string]: unknown;
}

interface RemoteRuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  [key: string]: unknown;
}

type WorkspaceProviderOptions = {
  tenantId?: number | null;
  allowDefaultFallback?: boolean;
};

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Derive the remote workspace base URL from runtime_config.
 * runtime_config.baseUrl is typically https://host/veri/api/v1 — strip the
 * /veri/api/v1 suffix to get the host, then append /veri/api/workspace.
 */
function getRemoteWorkspaceBase(config: RemoteRuntimeConfig): string {
  const rawBase = config.baseUrl ?? process.env.VERI_BASE_URL ?? '';
  const hostRoot = rawBase.replace(/\/veri\/api\/v1\/?$/, '');
  return `${hostRoot}/veri/api/workspace`;
}

function parseRuntimeConfig(agent: AgentRow): RemoteRuntimeConfig {
  if (!agent.runtime_config) return {};
  try {
    return JSON.parse(agent.runtime_config as string) as RemoteRuntimeConfig;
  } catch {
    return {};
  }
}

/**
 * resolveWorkspaceProvider — factory that returns the correct WorkspaceProvider
 * for a given agent ID. Falls back to the default local workspace if no agent
 * is specified or the agent record is not found.
 *
 * Provider selection:
 *   - runtime_type='veri' → RemoteWorkspaceProvider (API-backed)
 *   - openclaw_agent_id set → LocalWorkspaceProvider (standard OpenClaw workspace path)
 *   - workspace_path set → LocalWorkspaceProvider
 *   - fallback → LocalWorkspaceProvider with DEFAULT_WORKSPACE_ROOT
 */
export async function resolveWorkspaceProvider(agentId?: string | number, options: WorkspaceProviderOptions = {}): Promise<WorkspaceProvider> {
  const tenantId = options.tenantId ?? null;
  const allowDefaultFallback = options.allowDefaultFallback !== false;
  if (!agentId) {
    if (tenantId !== null) {
      const db = getDb();
      const deletedFilter = (async () => {
        try {
          const columns = await db.all(`PRAGMA table_info(agents)`) as Array<{ name: string }>;
          return columns.some((column) => column.name === 'deleted_at') ? 'AND deleted_at IS NULL' : '';
        } catch {
          return '';
        }
      })();
      const tenantAtlas = await db.get(`
        SELECT *
        FROM agents
        WHERE tenant_id = ?
          AND system_role = ?
          ${deletedFilter}
        ORDER BY id ASC
        LIMIT 1
      `, tenantId, ATLAS_SYSTEM_ROLE) as AgentRow | undefined;
      if (tenantAtlas) {
        return await resolveWorkspaceProvider(tenantAtlas.id, { tenantId, allowDefaultFallback: false });
      }
      return allowDefaultFallback ? new LocalWorkspaceProvider(await resolveAtlasWorkspaceRoot() || DEFAULT_WORKSPACE_ROOT) : new EmptyWorkspaceProvider();
    }
    return new LocalWorkspaceProvider(await resolveAtlasWorkspaceRoot() || DEFAULT_WORKSPACE_ROOT);
  }

  try {
    const db = getDb();
    const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId) as AgentRow | undefined;
    if (!agent) {
      if (allowDefaultFallback) return new LocalWorkspaceProvider(await resolveAtlasWorkspaceRoot() || DEFAULT_WORKSPACE_ROOT);
      throw new FileNotFoundError(`Agent not found: ${agentId}`);
    }

    if (tenantId !== null && Number(agent.tenant_id) !== tenantId) {
      throw new FileNotFoundError(`Agent not found in tenant: ${agentId}`);
    }

    // Remote agent (e.g. Custom)
    if (agent.runtime_type === 'veri') {
      const config = parseRuntimeConfig(agent);
      return new RemoteWorkspaceProvider({
        baseUrl: getRemoteWorkspaceBase(config),
        apiKey: config.apiKey ?? process.env.VERI_API_KEY ?? '',
      });
    }

    // Local with explicit workspace_path
    if (agent.workspace_path) {
      return new LocalWorkspaceProvider(agent.workspace_path);
    }

    // Local OpenClaw agent
    if (agent.openclaw_agent_id) {
      return new LocalWorkspaceProvider(
        path.join(os.homedir(), `.openclaw/workspace-${agent.openclaw_agent_id}`),
      );
    }
  } catch {
    if (!allowDefaultFallback) throw new FileNotFoundError(`Workspace not found for agent: ${agentId}`);
    // fall through
  }

  return new LocalWorkspaceProvider(await resolveAtlasWorkspaceRoot() || DEFAULT_WORKSPACE_ROOT);
}
