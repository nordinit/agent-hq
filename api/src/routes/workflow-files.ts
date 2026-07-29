import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { nowTimestamp } from '../lib/timestamps';

const router = Router({ mergeParams: true });

const REPO_ROOT = path.resolve(__dirname, '../../..');
function getUploadsBase(): string {
  return process.env.AGENT_HQ_WORKFLOW_UPLOADS_DIR
    ?? path.join(REPO_ROOT, 'uploads', 'workflows');
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const params = req.params as { projectId?: string; workflowId?: string; id?: string };
    const projectId = params.projectId ?? params.id;
    const workflowId = params.workflowId;
    const dir = path.join(getUploadsBase(), String(projectId), String(workflowId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

const upload = multer({ storage });

type WorkflowScope = {
  tenant_id: number;
  project_id: number;
  workflow_id: number;
};

type WorkflowFileRow = {
  id: number;
  tenant_id: number;
  project_id: number;
  workflow_id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  file_path: string;
  uploaded_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  current_version: number;
  current_version_id: number | null;
  scope: 'workflow';
};

const WORKFLOW_FILE_RESPONSE_SELECT = `
  id, tenant_id, project_id, workflow_id, filename, original_name, mime_type, size_bytes,
  created_at, uploaded_by, updated_at, updated_by, current_version, current_version_id,
  'workflow' AS scope
`;

const WORKFLOW_FILE_VERSION_SELECT = `
  id, tenant_id, project_id, workflow_id, file_id, version_number, filename, original_name,
  mime_type, size_bytes, created_by, created_at, change_source, 'workflow' AS scope
`;

function routeErrorStatus(err: unknown): number {
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status?: number }).status) : 500;
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}

function routeErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;
}

function sendRouteError(res: Response, err: unknown): Response {
  const code = routeErrorCode(err);
  return res.status(routeErrorStatus(err)).json({
    error: err instanceof Error ? err.message : String(err),
    ...(code ? { code } : {}),
  });
}

function resolveWorkflowScope(
  db: ReturnType<typeof getDb>,
  params: { projectId?: string; workflowId?: string; id?: string },
  tenantId: number,
): WorkflowScope | undefined {
  const projectId = params.projectId ?? params.id;
  const workflowId = params.workflowId;
  if (!projectId || !workflowId) return undefined;
  return db.prepare(`
    SELECT s.tenant_id, s.project_id, s.id AS workflow_id
    FROM sprints s
    JOIN projects p ON p.id = s.project_id
    WHERE s.id = ? AND s.project_id = ? AND p.tenant_id = ? AND COALESCE(s.tenant_id, p.tenant_id) = p.tenant_id
  `).get(workflowId, projectId, tenantId) as WorkflowScope | undefined;
}

function getWorkflowFileForTenant(
  db: ReturnType<typeof getDb>,
  scope: WorkflowScope,
  fileId: string | number,
): WorkflowFileRow | undefined {
  return db.prepare(`
    SELECT
      wf.id, wf.tenant_id, wf.project_id, wf.workflow_id, wf.filename, wf.original_name,
      wf.mime_type, wf.size_bytes, wf.file_path, wf.uploaded_by, wf.created_at,
      wf.updated_by, wf.updated_at, wf.current_version, wf.current_version_id,
      'workflow' AS scope
    FROM workflow_files wf
    WHERE wf.id = ? AND wf.tenant_id = ? AND wf.project_id = ? AND wf.workflow_id = ?
  `).get(fileId, scope.tenant_id, scope.project_id, scope.workflow_id) as WorkflowFileRow | undefined;
}

function insertWorkflowFileVersion(
  db: ReturnType<typeof getDb>,
  input: {
    scope: WorkflowScope;
    fileId: number | bigint;
    versionNumber: number;
    file: Express.Multer.File;
    actor: string;
    timestamp: string;
    changeSource: string;
  },
): number | bigint {
  const result = db.prepare(`
    INSERT INTO workflow_file_versions (
      tenant_id, project_id, workflow_id, file_id, version_number, filename, original_name,
      mime_type, size_bytes, file_path, created_by, created_at, change_source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.scope.tenant_id,
    input.scope.project_id,
    input.scope.workflow_id,
    input.fileId,
    input.versionNumber,
    input.file.filename,
    input.file.originalname,
    input.file.mimetype,
    input.file.size,
    input.file.path,
    input.actor,
    input.timestamp,
    input.changeSource,
  );
  return result.lastInsertRowid;
}

function cleanupUploadedFile(file: Express.Multer.File | undefined): void {
  if (!file) return;
  try {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  } catch (fsErr) {
    console.warn('[workflow-files] Failed to clean uploaded file:', fsErr);
  }
}

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const scope = resolveWorkflowScope(db, req.params, tenantId);
    if (!scope) return res.status(404).json({ error: 'Workflow not found' });

    const files = db.prepare(`
      SELECT ${WORKFLOW_FILE_RESPONSE_SELECT}
      FROM workflow_files
      WHERE tenant_id = ? AND project_id = ? AND workflow_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(scope.tenant_id, scope.project_id, scope.workflow_id);

    return res.json(files);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

router.post('/', upload.single('file'), (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const scope = resolveWorkflowScope(db, req.params, tenantId);
    if (!scope) {
      cleanupUploadedFile(req.file);
      return res.status(404).json({ error: 'Workflow not found' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });

    const uploadedBy = (req.body as { uploaded_by?: string }).uploaded_by ?? 'manual';
    const now = nowTimestamp();

    const result = db.transaction(() => {
      const insertFile = db.prepare(`
        INSERT INTO workflow_files (
          tenant_id, project_id, workflow_id, filename, original_name, mime_type, size_bytes,
          file_path, uploaded_by, created_at, updated_by, updated_at, current_version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        scope.tenant_id,
        scope.project_id,
        scope.workflow_id,
        req.file!.filename,
        req.file!.originalname,
        req.file!.mimetype,
        req.file!.size,
        req.file!.path,
        uploadedBy,
        now,
        uploadedBy,
        now,
      );

      const versionId = insertWorkflowFileVersion(db, {
        scope,
        fileId: insertFile.lastInsertRowid,
        versionNumber: 1,
        file: req.file!,
        actor: uploadedBy,
        timestamp: now,
        changeSource: 'api_upload',
      });
      db.prepare('UPDATE workflow_files SET current_version_id = ? WHERE id = ?').run(versionId, insertFile.lastInsertRowid);
      return insertFile;
    })();

    const record = db.prepare(`SELECT ${WORKFLOW_FILE_RESPONSE_SELECT} FROM workflow_files WHERE id = ?`).get(result.lastInsertRowid);
    return res.status(201).json(record);
  } catch (err) {
    cleanupUploadedFile(req.file);
    return sendRouteError(res, err);
  }
});

router.get('/:fileId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const scope = resolveWorkflowScope(db, req.params, tenantId);
    if (!scope) return res.status(404).json({ error: 'Workflow not found' });
    const file = getWorkflowFileForTenant(db, scope, req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    return res.json(file);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

router.get('/:fileId/download', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const scope = resolveWorkflowScope(db, req.params, tenantId);
    if (!scope) return res.status(404).json({ error: 'Workflow not found' });
    const file = getWorkflowFileForTenant(db, scope, req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!fs.existsSync(file.file_path)) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    return res.sendFile(path.resolve(file.file_path));
  } catch (err) {
    return sendRouteError(res, err);
  }
});

router.get('/:fileId/versions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const scope = resolveWorkflowScope(db, req.params, tenantId);
    if (!scope) return res.status(404).json({ error: 'Workflow not found' });
    const file = getWorkflowFileForTenant(db, scope, req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const versions = db.prepare(`
      SELECT ${WORKFLOW_FILE_VERSION_SELECT}
      FROM workflow_file_versions
      WHERE tenant_id = ? AND project_id = ? AND workflow_id = ? AND file_id = ?
      ORDER BY version_number DESC
    `).all(scope.tenant_id, scope.project_id, scope.workflow_id, req.params.fileId);

    return res.json(versions);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

router.put('/:fileId', upload.single('file'), (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const scope = resolveWorkflowScope(db, req.params, tenantId);
    if (!scope) {
      cleanupUploadedFile(req.file);
      return res.status(404).json({ error: 'Workflow not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });

    const file = getWorkflowFileForTenant(db, scope, req.params.fileId);
    if (!file) {
      cleanupUploadedFile(req.file);
      return res.status(404).json({ error: 'File not found' });
    }

    const updatedBy = (req.body as { uploaded_by?: string; updated_by?: string }).updated_by
      ?? (req.body as { uploaded_by?: string; updated_by?: string }).uploaded_by
      ?? 'manual';
    const now = nowTimestamp();
    const nextVersion = Number(file.current_version ?? 1) + 1;

    db.transaction(() => {
      const versionId = insertWorkflowFileVersion(db, {
        scope,
        fileId: file.id,
        versionNumber: nextVersion,
        file: req.file!,
        actor: updatedBy,
        timestamp: now,
        changeSource: 'api_replace',
      });

      db.prepare(`
        UPDATE workflow_files
        SET filename = ?, original_name = ?, mime_type = ?, size_bytes = ?, file_path = ?,
          updated_by = ?, updated_at = ?, current_version = ?, current_version_id = ?
        WHERE id = ? AND tenant_id = ? AND project_id = ? AND workflow_id = ?
      `).run(
        req.file!.filename,
        req.file!.originalname,
        req.file!.mimetype,
        req.file!.size,
        req.file!.path,
        updatedBy,
        now,
        nextVersion,
        versionId,
        file.id,
        scope.tenant_id,
        scope.project_id,
        scope.workflow_id,
      );
    })();

    const record = db.prepare(`SELECT ${WORKFLOW_FILE_RESPONSE_SELECT} FROM workflow_files WHERE id = ?`).get(file.id);
    return res.json(record);
  } catch (err) {
    cleanupUploadedFile(req.file);
    return sendRouteError(res, err);
  }
});

router.delete('/:fileId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const scope = resolveWorkflowScope(db, req.params, tenantId);
    if (!scope) return res.status(404).json({ error: 'Workflow not found' });
    const file = getWorkflowFileForTenant(db, scope, req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    try {
      const versions = db.prepare(`
        SELECT file_path FROM workflow_file_versions
        WHERE tenant_id = ? AND project_id = ? AND workflow_id = ? AND file_id = ?
      `).all(scope.tenant_id, scope.project_id, scope.workflow_id, req.params.fileId) as Array<{ file_path: string }>;
      const paths = new Set([file.file_path, ...versions.map((version) => version.file_path)]);
      for (const filePath of paths) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (fsErr) {
      console.warn('[workflow-files] Failed to delete from disk:', fsErr);
    }

    db.prepare('DELETE FROM workflow_files WHERE id = ? AND tenant_id = ? AND project_id = ? AND workflow_id = ?')
      .run(file.id, scope.tenant_id, scope.project_id, scope.workflow_id);
    return res.json({ ok: true });
  } catch (err) {
    return sendRouteError(res, err);
  }
});

export default router;
