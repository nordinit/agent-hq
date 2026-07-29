import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import { getDb } from '../../db/client';

const CHAT_UPLOADS_BASE = process.env.AGENT_HQ_CHAT_UPLOADS_DIR
  ?? path.join(path.resolve(__dirname, '../../../..'), 'uploads', 'chat');

const chatAttachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(CHAT_UPLOADS_BASE, { recursive: true });
    cb(null, CHAT_UPLOADS_BASE);
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
      const record = await db.get('SELECT * FROM chat_attachments WHERE id = ?', parseInt(req.params.id, 10)) as Record<string, unknown> | undefined;
      if (!record) return res.status(404).json({ error: 'Attachment not found' });
      const filepath = record.filepath as string;
      if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found on disk' });
      res.setHeader('Content-Disposition', `inline; filename="${record.filename as string}"`);
      res.setHeader('Content-Type', record.mime_type as string);
      return res.sendFile(filepath);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });
}
