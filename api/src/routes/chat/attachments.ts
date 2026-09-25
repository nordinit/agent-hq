import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import { getDb } from '../../db/client';
import type { Db } from '../../db/adapter/types';
import { resolveUploadsRoot } from '../../config';
import { setUserContentHeaders } from '../../lib/userContentHeaders';
import { parseIdParam } from '../../lib/routeParams';
import { resolveTenantIdFromRequest } from '../../lib/tenantContext';

function getChatUploadsBase(): string {
  return process.env.AGENT_HQ_CHAT_UPLOADS_DIR ?? path.join(resolveUploadsRoot(), 'chat');
}

const chatAttachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadsBase = getChatUploadsBase();
    fs.mkdirSync(uploadsBase, { recursive: true });
    cb(null, uploadsBase);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'text/', 'application/pdf', 'application/json',
  'application/zip', 'application/x-zip', 'application/msword',
  'application/vnd.openxmlformats-officedocument', 'application/octet-stream'];
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const chatUpload = multer({
  storage: chatAttachmentStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_MIME_PREFIXES.some(p => file.mimetype.startsWith(p));
    if (!allowed) return cb(new Error(`File type ${file.mimetype} is not allowed`));
    cb(null, true);
  },
});

/**
 * chat_attachments has no tenant column; an attachment belongs to the tenant of the run or agent
 * it was uploaded for, and to no tenant when it was uploaded before a run existed.
 */
async function findAttachmentWithOwner(db: Db, attachmentId: number): Promise<Record<string, unknown> | undefined> {
  return await db.get(`
    SELECT ca.*, COALESCE(ji.tenant_id, run_agent.tenant_id, a.tenant_id) AS owner_tenant_id
    FROM chat_attachments ca
    LEFT JOIN job_instances ji ON ji.id = ca.instance_id
    LEFT JOIN agents run_agent ON run_agent.id = ji.agent_id
    LEFT JOIN agents a ON a.id = ca.agent_id
    WHERE ca.id = ?
  `, attachmentId) as Record<string, unknown> | undefined;
}

/**
 * Whether the caller may read this attachment. A signed link authorizes exactly the attachment it
 * was minted for (the chat proxy mints them for the operator's own turn), so the tenant check
 * applies to credentialed requests: the attachment's owner must be the requested tenant. One
 * with no owner is readable by the operator, who is not bound to a tenant, and by a super-admin
 * key, but not by a tenant-bound MCP key.
 */
async function attachmentVisibleToRequest(db: Db, req: Request, attachment: Record<string, unknown>): Promise<boolean> {
  if (req.apiCredential === 'signed_link') return true;
  const tenantId = await resolveTenantIdFromRequest(db, req);
  const owner = attachment.owner_tenant_id == null ? null : Number(attachment.owner_tenant_id);
  if (owner !== null) return owner === tenantId;
  return !req.mcpIdentity || req.mcpIdentity.globalAdminAccess;
}

export function registerAttachmentRoutes(router: Router): void {
  router.post('/attachments', (req: Request, res: Response) => {
    chatUpload.single('file')(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ ok: false, error: 'File too large (max 25 MB)' });
        }
        return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'No file uploaded (field name must be "file")' });
      }
      try {
        const db = getDb();
        const body = req.body as { instance_id?: string; agent_id?: string; uploaded_by?: string };
        const instanceId = body.instance_id ? parseInt(body.instance_id, 10) : null;
        const agentId = body.agent_id ? parseInt(body.agent_id, 10) : null;
        const uploadedBy = body.uploaded_by ?? 'user';

        // The run or agent named here decides who may read the attachment later, so it must be
        // one the caller can see.
        const tenantId = await resolveTenantIdFromRequest(db, req);
        const instanceVisible = instanceId == null || Boolean(await db.get(
          'SELECT id FROM job_instances WHERE id = ? AND tenant_id = ?', instanceId, tenantId,
        ));
        const agentVisible = agentId == null || Boolean(await db.get(
          'SELECT id FROM agents WHERE id = ? AND tenant_id = ?', agentId, tenantId,
        ));
        if (!instanceVisible || !agentVisible) {
          fs.unlinkSync(req.file.path);
          return res.status(404).json({ ok: false, error: instanceVisible ? 'Agent not found' : 'Instance not found' });
        }

        const result = await db.run(`
          INSERT INTO chat_attachments (instance_id, agent_id, filename, filepath, mime_type, size, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, instanceId, agentId, req.file.filename, req.file.path, req.file.mimetype, req.file.size, uploadedBy);

        const record = await db.get('SELECT * FROM chat_attachments WHERE id = ?', result.lastInsertId) as Record<string, unknown>;

        return res.json({
          ok: true,
          attachment: {
            ...record,
            url: `/api/v1/chat/attachments/${result.lastInsertId}/download`,
          },
        });
      } catch (dbErr) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(500).json({ ok: false, error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
      }
    });
  });

  router.get('/attachments/:id/download', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const attachmentId = parseIdParam(req.params.id);
      const record = attachmentId === null ? undefined : await findAttachmentWithOwner(db, attachmentId);
      if (!record || !await attachmentVisibleToRequest(db, req, record)) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      const filepath = record.filepath as string;
      if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found on disk' });
      // The MIME type is whatever the uploader declared; only inert types are shown inline.
      setUserContentHeaders(res, { mimeType: record.mime_type, filename: String(record.filename ?? '') });
      return res.sendFile(filepath);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) {
        return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
      }
      return res.status(500).json({ error: String(err) });
    }
  });
}
