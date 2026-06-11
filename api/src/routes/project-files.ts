import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const router = Router({ mergeParams: true });

const REPO_ROOT = path.resolve(__dirname, '../../..');
function getUploadsBase(): string {
  return process.env.AGENT_HQ_PROJECT_UPLOADS_DIR ?? path.join(REPO_ROOT, 'uploads', 'projects');
}

// Dynamic multer storage — creates per-project directory
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const projectId = (req.params as { id: string }).id;
    const dir = path.join(getUploadsBase(), projectId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const unique = `${Date.now()}-${base}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({ storage });

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

function findProjectForTenant(db: ReturnType<typeof getDb>, projectId: string | number, tenantId: number): { id: number } | undefined {
  return db.prepare('SELECT id FROM projects WHERE id = ? AND tenant_id = ?').get(projectId, tenantId) as { id: number } | undefined;
}

type ProjectFileRow = {
  id: number;
  project_id: number;
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
};

const PROJECT_FILE_RESPONSE_SELECT = `
  id, filename, original_name, mime_type, size_bytes, created_at, uploaded_by,
  updated_at, updated_by, current_version, current_version_id
`;

const PROJECT_FILE_VERSION_SELECT = `
  id, tenant_id, project_id, file_id, version_number, filename, original_name, mime_type,
  size_bytes, created_by, created_at, change_source
`;

function getProjectFileForTenant(
  db: ReturnType<typeof getDb>,
  projectId: string | number,
  fileId: string | number,
  tenantId: number,
): ProjectFileRow | undefined {
  return db.prepare(`
    SELECT
      pf.id, pf.project_id, pf.filename, pf.original_name, pf.mime_type, pf.size_bytes, pf.file_path,
      pf.uploaded_by, pf.created_at, pf.updated_by, pf.updated_at, pf.current_version, pf.current_version_id
    FROM project_files pf
    JOIN projects p ON p.id = pf.project_id
    WHERE pf.id = ? AND pf.project_id = ? AND p.tenant_id = ?
  `).get(fileId, projectId, tenantId) as ProjectFileRow | undefined;
}

function insertProjectFileVersion(
  db: ReturnType<typeof getDb>,
  input: {
    tenantId: number;
    projectId: string | number;
    fileId: number | bigint;
    versionNumber: number;
    file: Express.Multer.File;
    actor: string;
    timestamp: string;
    changeSource: string;
  },
): number | bigint {
  const result = db.prepare(`
    INSERT INTO project_file_versions (
      tenant_id, project_id, file_id, version_number, filename, original_name, mime_type,
      size_bytes, file_path, created_by, created_at, change_source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.tenantId,
    input.projectId,
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
    console.warn('[project-files] Failed to clean uploaded file:', fsErr);
  }
}

// GET /api/v1/projects/:id/files
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const project = findProjectForTenant(db, req.params.id, tenantId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const files = db.prepare(`
      SELECT ${PROJECT_FILE_RESPONSE_SELECT}
      FROM project_files
      WHERE project_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(req.params.id);

    return res.json(files);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// POST /api/v1/projects/:id/files
router.post('/', upload.single('file'), (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const project = findProjectForTenant(db, req.params.id, tenantId);
    if (!project) {
      // Clean up uploaded file if project not found
      cleanupUploadedFile(req.file);
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
    }

    const uploadedBy = (req.body as { uploaded_by?: string }).uploaded_by ?? 'manual';
    const now = new Date().toISOString();

    const result = db.transaction(() => {
      const insertFile = db.prepare(`
        INSERT INTO project_files (
          project_id, filename, original_name, mime_type, size_bytes, file_path,
          uploaded_by, created_at, updated_by, updated_at, current_version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        req.params.id,
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

      const versionId = insertProjectFileVersion(db, {
        tenantId,
        projectId: req.params.id,
        fileId: insertFile.lastInsertRowid,
        versionNumber: 1,
        file: req.file!,
        actor: uploadedBy,
        timestamp: now,
        changeSource: 'api_upload',
      });

      db.prepare('UPDATE project_files SET current_version_id = ? WHERE id = ?').run(versionId, insertFile.lastInsertRowid);
      return insertFile;
    })();

    const record = db.prepare(`
      SELECT ${PROJECT_FILE_RESPONSE_SELECT}
      FROM project_files WHERE id = ?
    `).get(result.lastInsertRowid);

    return res.status(201).json(record);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// GET /api/v1/projects/:id/files/:fileId
router.get('/:fileId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const project = findProjectForTenant(db, req.params.id, tenantId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const file = getProjectFileForTenant(db, req.params.id, req.params.fileId, tenantId);

    if (!file) return res.status(404).json({ error: 'File not found' });
    return res.json(file);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// GET /api/v1/projects/:id/files/:fileId/download
router.get('/:fileId/download', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const project = findProjectForTenant(db, req.params.id, tenantId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const file = getProjectFileForTenant(db, req.params.id, req.params.fileId, tenantId) as {
      id: number; filename: string; original_name: string;
      mime_type: string; file_path: string;
    } | undefined;

    if (!file) return res.status(404).json({ error: 'File not found' });

    if (!fs.existsSync(file.file_path)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.original_name)}"`
    );
    return res.sendFile(path.resolve(file.file_path));
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// GET /api/v1/projects/:id/files/:fileId/versions
router.get('/:fileId/versions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const project = findProjectForTenant(db, req.params.id, tenantId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const file = getProjectFileForTenant(db, req.params.id, req.params.fileId, tenantId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const versions = db.prepare(`
      SELECT ${PROJECT_FILE_VERSION_SELECT}
      FROM project_file_versions
      WHERE tenant_id = ? AND project_id = ? AND file_id = ?
      ORDER BY version_number DESC
    `).all(tenantId, req.params.id, req.params.fileId);

    return res.json(versions);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// PUT /api/v1/projects/:id/files/:fileId
router.put('/:fileId', upload.single('file'), (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const project = findProjectForTenant(db, req.params.id, tenantId);
    if (!project) {
      cleanupUploadedFile(req.file);
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
    }

    const file = getProjectFileForTenant(db, req.params.id, req.params.fileId, tenantId);
    if (!file) {
      cleanupUploadedFile(req.file);
      return res.status(404).json({ error: 'File not found' });
    }

    const updatedBy = (req.body as { uploaded_by?: string; updated_by?: string }).updated_by
      ?? (req.body as { uploaded_by?: string; updated_by?: string }).uploaded_by
      ?? 'manual';
    const now = new Date().toISOString();
    const nextVersion = Number(file.current_version ?? 1) + 1;

    db.transaction(() => {
      const versionId = insertProjectFileVersion(db, {
        tenantId,
        projectId: req.params.id,
        fileId: file.id,
        versionNumber: nextVersion,
        file: req.file!,
        actor: updatedBy,
        timestamp: now,
        changeSource: 'api_replace',
      });

      db.prepare(`
        UPDATE project_files
        SET filename = ?, original_name = ?, mime_type = ?, size_bytes = ?, file_path = ?,
          updated_by = ?, updated_at = ?, current_version = ?, current_version_id = ?
        WHERE id = ? AND project_id = ?
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
        req.params.id,
      );
    })();

    const record = db.prepare(`
      SELECT ${PROJECT_FILE_RESPONSE_SELECT}
      FROM project_files WHERE id = ?
    `).get(file.id);

    return res.json(record);
  } catch (err) {
    cleanupUploadedFile(req.file);
    return sendRouteError(res, err);
  }
});

// DELETE /api/v1/projects/:id/files/:fileId
router.delete('/:fileId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const project = findProjectForTenant(db, req.params.id, tenantId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const file = getProjectFileForTenant(db, req.params.id, req.params.fileId, tenantId);

    if (!file) return res.status(404).json({ error: 'File not found' });

    // Delete from disk (best-effort)
    try {
      const versions = db.prepare(`
        SELECT file_path FROM project_file_versions
        WHERE tenant_id = ? AND project_id = ? AND file_id = ?
      `).all(tenantId, req.params.id, req.params.fileId) as Array<{ file_path: string }>;
      const paths = new Set([file.file_path, ...versions.map((version) => version.file_path)]);
      for (const filePath of paths) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (fsErr) {
      console.warn('[project-files] Failed to delete from disk:', fsErr);
    }

    db.prepare('DELETE FROM project_files WHERE id = ?').run(file.id);
    return res.json({ ok: true });
  } catch (err) {
    return sendRouteError(res, err);
  }
});

export default router;
