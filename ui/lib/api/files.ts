import { apiFetch, getApiBase } from './http';
import type { ArtifactFile, ArtifactTree, ProjectFile, ProjectFileVersion, TaskAttachment } from './types';

export const filesClient = {
// Artifacts / Workspaces
getArtifactTree: (agentId?: number) => {
  const qs = agentId ? `?agentId=${agentId}` : '';
  return apiFetch<ArtifactTree>(`/api/v1/artifacts/tree${qs}`);
},
getArtifactFile: (path: string, agentId?: number) => {
  const qs = agentId ? `&agentId=${agentId}` : '';
  return apiFetch<ArtifactFile>(`/api/v1/artifacts/file?path=${encodeURIComponent(path)}${qs}`);
},
saveArtifactFile: (path: string, content: string, agentId?: number) => {
  const qs = agentId ? `&agentId=${agentId}` : '';
  return apiFetch<{ ok: boolean; path: string; size: number; modified: string }>(
    `/api/v1/artifacts/file?path=${encodeURIComponent(path)}${qs}`,
    { method: 'PUT', body: JSON.stringify({ content }) }
  );
},
deleteArtifact: (path: string, agentId?: number) => {
  const qs = agentId ? `&agentId=${agentId}` : '';
  return apiFetch<{ ok: boolean; path: string }>(
    `/api/v1/artifacts/file?path=${encodeURIComponent(path)}${qs}`,
    { method: 'DELETE' }
  );
},
renameArtifact: (oldPath: string, newPath: string, agentId?: number) => {
  const qs = agentId ? `?agentId=${agentId}` : '';
  return apiFetch<{ ok: boolean; oldPath: string; newPath: string }>(
    `/api/v1/artifacts/rename${qs}`,
    { method: 'POST', body: JSON.stringify({ oldPath, newPath }) }
  );
},
createArtifactDir: (path: string, agentId?: number) => {
  const qs = agentId ? `&agentId=${agentId}` : '';
  return apiFetch<{ ok: boolean; path: string }>(
    `/api/v1/artifacts/mkdir?path=${encodeURIComponent(path)}${qs}`,
    { method: 'POST' }
  );
},
// Project Files
getProjectFiles: (projectId: number) =>
  apiFetch<ProjectFile[]>(`/api/v1/projects/${projectId}/files`),
getProjectFileVersions: (projectId: number, fileId: number) =>
  apiFetch<ProjectFileVersion[]>(`/api/v1/projects/${projectId}/files/${fileId}/versions`),
uploadProjectFile: async (projectId: number, file: File, uploadedBy?: string) => {
  const formData = new FormData();
  formData.append('file', file);
  if (uploadedBy) formData.append('uploaded_by', uploadedBy);
  const res = await fetch(`${getApiBase()}/api/v1/projects/${projectId}/files`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = `Upload failed: ${res.status}`;
    try { msg = (JSON.parse(body) as { error?: string }).error ?? msg; } catch { /* */ }
    throw new Error(msg);
  }
  return res.json() as Promise<ProjectFile>;
},
replaceProjectFile: async (projectId: number, fileId: number, file: File, uploadedBy?: string) => {
  const formData = new FormData();
  formData.append('file', file);
  if (uploadedBy) formData.append('uploaded_by', uploadedBy);
  const res = await fetch(`${getApiBase()}/api/v1/projects/${projectId}/files/${fileId}`, {
    method: 'PUT',
    body: formData,
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = `Replace failed: ${res.status}`;
    try { msg = (JSON.parse(body) as { error?: string }).error ?? msg; } catch { /* */ }
    throw new Error(msg);
  }
  return res.json() as Promise<ProjectFile>;
},
getProjectFileUrl: (projectId: number, fileId: number) =>
  `${getApiBase()}/api/v1/projects/${projectId}/files/${fileId}/download`,
deleteProjectFile: (projectId: number, fileId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/projects/${projectId}/files/${fileId}`, { method: 'DELETE' }),
};
