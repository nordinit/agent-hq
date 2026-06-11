import type { ProjectFile, ProjectFileVersion } from './api/types.ts';

export function formatProjectFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatProjectFileDate(dateStr: string): string {
  try {
    return new Date(`${dateStr}Z`).toLocaleString();
  } catch {
    return dateStr;
  }
}

export function getProjectFileCurrentVersion(file: ProjectFile): number {
  return file.current_version ?? 1;
}

export function getProjectFileLatestMetadata(file: ProjectFile): string[] {
  return [
    formatProjectFileBytes(file.size_bytes),
    `Updated ${formatProjectFileDate(file.updated_at ?? file.created_at)}`,
    `by ${file.updated_by ?? file.uploaded_by}`,
  ];
}

export function getProjectFileOriginalUploadMetadata(file: ProjectFile): string[] {
  return [
    `Uploaded ${formatProjectFileDate(file.created_at)}`,
    `by ${file.uploaded_by}`,
  ];
}

export function getProjectFileVersionMetadata(version: ProjectFileVersion): string[] {
  return [
    formatProjectFileDate(version.created_at),
    `by ${version.created_by}`,
    formatProjectFileBytes(version.size_bytes),
  ];
}
