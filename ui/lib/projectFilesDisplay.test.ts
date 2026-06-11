import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectFile, ProjectFileVersion } from './api/types.ts';
import {
  formatProjectFileBytes,
  getProjectFileCurrentVersion,
  getProjectFileLatestMetadata,
  getProjectFileOriginalUploadMetadata,
  getProjectFileVersionMetadata,
} from './projectFilesDisplay.ts';

const projectFile: ProjectFile = {
  id: 42,
  filename: 'project-42/spec-v2.md',
  original_name: 'spec.md',
  mime_type: 'text/markdown',
  size_bytes: 16,
  created_at: '2026-06-05T18:00:00.000',
  uploaded_by: 'initial-uploader',
  updated_at: '2026-06-05T19:30:00.000',
  updated_by: 'latest-editor',
  current_version: 2,
  current_version_id: 12,
};

test('ProjectFiles latest metadata separates current update from original upload', () => {
  assert.equal(getProjectFileCurrentVersion(projectFile), 2);
  assert.deepEqual(getProjectFileLatestMetadata(projectFile), [
    '16 B',
    `Updated ${new Date('2026-06-05T19:30:00.000Z').toLocaleString()}`,
    'by latest-editor',
  ]);
  assert.deepEqual(getProjectFileOriginalUploadMetadata(projectFile), [
    `Uploaded ${new Date('2026-06-05T18:00:00.000Z').toLocaleString()}`,
    'by initial-uploader',
  ]);
});

test('ProjectFiles metadata falls back to upload fields for pre-version rows', () => {
  const legacyFile = {
    ...projectFile,
    updated_at: undefined,
    updated_by: undefined,
    current_version: undefined,
  } as unknown as ProjectFile;

  assert.equal(getProjectFileCurrentVersion(legacyFile), 1);
  assert.deepEqual(getProjectFileLatestMetadata(legacyFile), [
    '16 B',
    `Updated ${new Date('2026-06-05T18:00:00.000Z').toLocaleString()}`,
    'by initial-uploader',
  ]);
});

test('ProjectFiles version history displays audit actor, timestamp, and size', () => {
  const version: ProjectFileVersion = {
    id: 12,
    tenant_id: 1,
    project_id: 86,
    file_id: 42,
    version_number: 2,
    filename: 'project-42/spec-v2.md',
    original_name: 'spec.md',
    mime_type: 'text/markdown',
    size_bytes: 1536,
    created_by: 'mcp-agent',
    created_at: '2026-06-05T20:00:00.000',
    change_source: 'mcp_replace',
  };

  assert.deepEqual(getProjectFileVersionMetadata(version), [
    new Date('2026-06-05T20:00:00.000Z').toLocaleString(),
    'by mcp-agent',
    '1.5 KB',
  ]);
});

test('ProjectFiles byte labels use stable units', () => {
  assert.equal(formatProjectFileBytes(512), '512 B');
  assert.equal(formatProjectFileBytes(2048), '2.0 KB');
  assert.equal(formatProjectFileBytes(2 * 1024 * 1024), '2.0 MB');
});
