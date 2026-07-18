'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { api, ProjectFile, ProjectFileVersion } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Upload, Download, Trash2, Eye, X, FileText, Image as ImageIcon, Package, History, Replace } from 'lucide-react';
import {
  formatProjectFileBytes,
  formatProjectFileDate,
  getProjectFileCurrentVersion,
  getProjectFileLatestMetadata,
  getProjectFileOriginalUploadMetadata,
  getProjectFileVersionMetadata,
} from '@/lib/projectFilesDisplay';

interface Props {
  projectId: number;
  workflowId?: number;
  scope?: 'project' | 'workflow';
}

function getFileIcon(mimeType: string): React.ReactNode {
  if (mimeType.startsWith('image/')) return <ImageIcon className="w-4 h-4 text-blue-400" />;
  if (
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown' ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'text/javascript' ||
    mimeType === 'text/typescript' ||
    mimeType === 'text/x-python' ||
    mimeType.startsWith('text/')
  ) return <FileText className="w-4 h-4 text-green-400" />;
  return <Package className="w-4 h-4 text-slate-400" />;
}

function isViewable(mimeType: string, name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const viewableExts = ['txt', 'md', 'json', 'yaml', 'yml', 'py', 'ts', 'tsx', 'js', 'jsx', 'html', 'css', 'sh', 'env', 'toml', 'ini', 'xml', 'csv', 'log'];
  const viewableImages = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
  return viewableExts.includes(ext) || viewableImages.includes(ext) || mimeType.startsWith('image/') || mimeType.startsWith('text/');
}

function isImage(mimeType: string, name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext);
}

export default function ProjectFiles({ projectId, workflowId, scope = workflowId ? 'workflow' : 'project' }: Props) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [viewFile, setViewFile] = useState<ProjectFile | null>(null);
  const [viewContent, setViewContent] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [replaceFileId, setReplaceFileId] = useState<number | null>(null);
  const [historyFile, setHistoryFile] = useState<ProjectFile | null>(null);
  const [versions, setVersions] = useState<ProjectFileVersion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const isWorkflowScope = scope === 'workflow';
  const fileScopeLabel = isWorkflowScope ? 'Workflow Files' : 'Project Files';
  const emptyLabel = isWorkflowScope
    ? 'No workflow files uploaded yet. Click "Add Workflow File" to upload one.'
    : 'No project files uploaded yet. Click "Add Project File" to upload one.';

  const load = useCallback(async () => {
    try {
      const data = isWorkflowScope && workflowId
        ? await api.getWorkflowFiles(projectId, workflowId)
        : await api.getProjectFiles(projectId);
      setFiles(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [isWorkflowScope, projectId, workflowId]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadProgress(`Uploading ${file.name}…`);
    try {
      if (isWorkflowScope && workflowId) await api.uploadWorkflowFile(projectId, workflowId, file);
      else await api.uploadProjectFile(projectId, file);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
      setUploadProgress(null);
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleReplaceSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || replaceFileId === null) return;
    setUploading(true);
    setUploadProgress(`Replacing with ${file.name}…`);
    try {
      if (isWorkflowScope && workflowId) await api.replaceWorkflowFile(projectId, workflowId, replaceFileId, file);
      else await api.replaceProjectFile(projectId, replaceFileId, file);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
      setUploadProgress(null);
      setReplaceFileId(null);
      if (replaceInputRef.current) replaceInputRef.current.value = '';
    }
  };

  const handleHistory = async (file: ProjectFile) => {
    setHistoryFile(file);
    setVersions([]);
    setHistoryLoading(true);
    try {
      const data = isWorkflowScope && workflowId
        ? await api.getWorkflowFileVersions(projectId, workflowId, file.id)
        : await api.getProjectFileVersions(projectId, file.id);
      setVersions(data);
    } catch (e) {
      setError(String(e));
      setHistoryFile(null);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleView = async (file: ProjectFile) => {
    setViewFile(file);
    setViewContent(null);
    setViewLoading(true);
    try {
      const url = isWorkflowScope && workflowId
        ? api.getWorkflowFileUrl(projectId, workflowId, file.id)
        : api.getProjectFileUrl(projectId, file.id);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
      const text = await res.text();
      setViewContent(text);
    } catch (e) {
      setViewContent(`Error loading file: ${String(e)}`);
    } finally {
      setViewLoading(false);
    }
  };

  const handleDownload = (file: ProjectFile) => {
    const url = isWorkflowScope && workflowId
      ? api.getWorkflowFileUrl(projectId, workflowId, file.id)
      : api.getProjectFileUrl(projectId, file.id);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.original_name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDelete = async (fileId: number) => {
    try {
      if (isWorkflowScope && workflowId) await api.deleteWorkflowFile(projectId, workflowId, fileId);
      else await api.deleteProjectFile(projectId, fileId);
      setDeleteConfirm(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-24">
      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">{fileScopeLabel}</h2>
        <div className="flex items-center gap-2">
          {uploadProgress && (
            <span className="text-xs text-amber-300 animate-pulse">{uploadProgress}</span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleUpload}
            disabled={uploading}
          />
          <input
            ref={replaceInputRef}
            type="file"
            className="hidden"
            onChange={handleReplaceSelect}
            disabled={uploading}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            loading={uploading}
          >
            <Upload className="w-3.5 h-3.5" /> {isWorkflowScope ? 'Add Workflow File' : 'Add Project File'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* File list */}
      {files.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-slate-500 text-sm">
            {emptyLabel}
          </div>
        </Card>
      ) : (
        <div className="space-y-1">
          {files.map(file => (
            <Card key={file.id} className="hover:border-slate-600 transition-colors">
              <div className="flex items-center gap-3">
                <div className="shrink-0">{getFileIcon(file.mime_type)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white text-sm font-medium truncate max-w-xs">
                      {file.original_name}
                    </span>
                    <Badge variant="workspace">{file.mime_type.split('/').pop()}</Badge>
                    <Badge variant="workspace">v{getProjectFileCurrentVersion(file)}</Badge>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 flex gap-3 flex-wrap">
                    {getProjectFileLatestMetadata(file).map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5 flex gap-3 flex-wrap">
                    {getProjectFileOriginalUploadMetadata(file).map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => handleHistory(file)} title="Version history">
                    <History className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReplaceFileId(file.id);
                      replaceInputRef.current?.click();
                    }}
                    title="Replace"
                  >
                    <Replace className="w-3.5 h-3.5" />
                  </Button>
                  {isViewable(file.mime_type, file.original_name) && (
                    <Button variant="ghost" size="sm" onClick={() => handleView(file)} title="View">
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => handleDownload(file)} title="Download">
                    <Download className="w-3.5 h-3.5" />
                  </Button>
                  {deleteConfirm === file.id ? (
                    <>
                      <span className="text-xs text-red-400">Delete?</span>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(file.id)}>
                        <span className="text-red-400 text-xs">Yes</span>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(null)}>
                        <X className="w-3 h-3" />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteConfirm(file.id)}
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* View Modal */}
      {viewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="bg-slate-800 border border-slate-600 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div className="flex items-center gap-2 min-w-0">
                {getFileIcon(viewFile.mime_type)}
                <span className="text-white font-medium truncate">{viewFile.original_name}</span>
                <span className="text-slate-500 text-xs">{formatProjectFileBytes(viewFile.size_bytes)}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="ghost" size="sm" onClick={() => handleDownload(viewFile)}>
                  <Download className="w-3.5 h-3.5" /> Download
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setViewFile(null); setViewContent(null); }}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
            {/* Modal Body */}
            <div className="flex-1 overflow-auto p-4">
              {viewLoading ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : isImage(viewFile.mime_type, viewFile.original_name) ? (
                <div className="flex items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={isWorkflowScope && workflowId ? api.getWorkflowFileUrl(projectId, workflowId, viewFile.id) : api.getProjectFileUrl(projectId, viewFile.id)}
                    alt={viewFile.original_name}
                    className="max-w-full max-h-[70vh] object-contain rounded-lg"
                  />
                </div>
              ) : (
                <pre className="text-slate-200 text-xs font-mono whitespace-pre-wrap break-words bg-slate-900 rounded-lg p-4 overflow-auto">
                  {viewContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Version History Modal */}
      {historyFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="bg-slate-800 border border-slate-600 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div className="flex items-center gap-2 min-w-0">
                <History className="w-4 h-4 text-amber-300" />
                <span className="text-white font-medium truncate">{historyFile.original_name}</span>
                <span className="text-slate-500 text-xs">v{getProjectFileCurrentVersion(historyFile)}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setHistoryFile(null); setVersions([]); }}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {historyLoading ? (
                <div className="flex items-center justify-center h-24">
                  <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div className="space-y-2">
                  {versions.map((version) => (
                    <div key={version.id} className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">Version {version.version_number}</span>
                            {version.version_number === historyFile.current_version && (
                              <Badge variant="workspace">current</Badge>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-slate-500 flex gap-3 flex-wrap">
                            {getProjectFileVersionMetadata(version).map((item) => (
                              <span key={item}>{item}</span>
                            ))}
                          </div>
                        </div>
                        <div className="text-right text-xs text-slate-500 shrink-0">
                          <div>{version.mime_type}</div>
                          <div className="max-w-[12rem] truncate">{version.filename}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {versions.length === 0 && (
                    <div className="text-center py-8 text-slate-500 text-sm">No versions recorded.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
