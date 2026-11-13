import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  archiveConfirmMessage,
  isArchivedProject,
  projectDeletionNotice,
  runningAfterArchiveNotice,
} from './projectArchive.ts';

const uiRoot = path.resolve(import.meta.dirname, '..');
const source = (file: string) => readFileSync(path.join(uiRoot, file), 'utf8');

test('a project is archived only when it has an archive time', () => {
  assert.equal(isArchivedProject({ archived_at: '2026-11-12T10:00:00Z' }), true);
  assert.equal(isArchivedProject({ archived_at: null }), false);
  assert.equal(isArchivedProject({}), false);
  assert.equal(isArchivedProject(null), false);
});

test('the archive confirmation says what stops and where to undo it', () => {
  const message = archiveConfirmMessage('Pool Client');
  assert.match(message, /^Archive "Pool Client"\?/);
  assert.match(message, /stop picking up its tasks/);
  assert.match(message, /Projects → Archived/);
});

test('notices count runs and agents', () => {
  assert.equal(runningAfterArchiveNotice(0), null);
  assert.equal(runningAfterArchiveNotice(1), '1 run is still finishing in the archived project.');
  assert.equal(runningAfterArchiveNotice(3), '3 runs are still finishing in the archived project.');
  assert.equal(projectDeletionNotice('Kayode', {}), 'Deleted Kayode.');
  assert.equal(
    projectDeletionNotice('Default Project', { agents_deleted: 2, agents_archived: 8, agents_kept: ['Atlas'] }),
    'Deleted Default Project (10 agents removed; Atlas kept).',
  );
});

test('archived projects are listed on their own page and reachable from Projects', () => {
  assert.match(source('lib/api/projects.ts'), /\/api\/v1\/projects\?archived=true/);
  assert.match(source('app/projects/page.tsx'), /href="\/projects\/archived"/);
  const archivedPage = source('app/projects/archived/page.tsx');
  assert.match(archivedPage, /api\.getArchivedProjects\(\)/);
  assert.match(archivedPage, /api\.unarchiveProject\(/);
  assert.match(archivedPage, /DeleteProjectModal/);
});

test('active projects offer Archive, and only archived ones offer Delete', () => {
  const index = source('app/projects/page.tsx');
  assert.match(index, /api\.archiveProject\(/);
  assert.doesNotMatch(index, /DeleteProjectModal/);
  const detail = source('app/projects/[id]/page.tsx');
  assert.match(detail, /api\.archiveProject\(/);
  assert.match(detail, /api\.unarchiveProject\(/);
  assert.match(detail, /archived && \(\s*<Button[\s\S]*?setShowDeleteModal\(true\)/);
});
