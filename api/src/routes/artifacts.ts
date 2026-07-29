/**
 * artifacts.ts — Workspace file operations (tree, read, write, delete, rename, mkdir, raw).
 *
 * Task #469: Refactored to use the WorkspaceProvider abstraction. Route handlers
 * no longer contain inline branching for local vs. remote agents — the provider
 * handles all differences transparently.
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import {
  resolveWorkspaceProvider,
  FileNotFoundError,
  PathTraversalError,
  RemoteUnavailableError,
} from '../lib/workspaceProvider';

const router = Router();

// ── Helper: extract agentId from query params ─────────────────────────────────

function getAgentId(req: Request): string | undefined {
  return req.query.agentId as string | undefined;
}

async function getWorkspaceProviderForRequest(req: Request) {
  const db = getDb();
  const tenantId = await resolveTenantIdFromRequest(db, req);
  return await resolveWorkspaceProvider(getAgentId(req), { tenantId, allowDefaultFallback: false });
}

// ── Helper: map provider errors to HTTP responses ─────────────────────────────

function handleProviderError(err: unknown, res: Response): Response {
  if (err instanceof PathTraversalError) {
    return res.status(403).json({ error: err.message });
  }
  if (err instanceof FileNotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  if (err instanceof RemoteUnavailableError) {
    return res.status(503).json({ error: err.message });
  }
  if (err instanceof Error && err.message === 'Path is a directory') {
    return res.status(400).json({ error: err.message });
  }
  return res.status(500).json({ error: String(err) });
}

// ── Route handlers ────────────────────────────────────────────────────────────

// GET /api/v1/artifacts/tree
router.get('/tree', async (req: Request, res: Response) => {
  try {
    const provider = await getWorkspaceProviderForRequest(req);
    const result = await provider.tree(4);
    return res.json(result);
  } catch (err) {
    return handleProviderError(err, res);
  }
});

// GET /api/v1/artifacts/file?path=...
router.get('/file', async (req: Request, res: Response) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) return res.status(400).json({ error: 'path query param required' });

    const provider = await getWorkspaceProviderForRequest(req);
    const result = await provider.readFile(relPath);
    return res.json(result);
  } catch (err) {
    return handleProviderError(err, res);
  }
});

// PUT /api/v1/artifacts/file?path=...
router.put('/file', async (req: Request, res: Response) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) return res.status(400).json({ error: 'path query param required' });

    const { content } = req.body as { content?: string };
    if (content === undefined) return res.status(400).json({ error: 'content is required' });

    const provider = await getWorkspaceProviderForRequest(req);
    const result = await provider.writeFile(relPath, content);
    return res.json(result);
  } catch (err) {
    return handleProviderError(err, res);
  }
});

// POST /api/v1/artifacts/file?agentId=...  — create/write file (path in body)
router.post('/file', async (req: Request, res: Response) => {
  try {
    const { path: relPath, content } = req.body as { path?: string; content?: string };
    if (!relPath) return res.status(400).json({ error: 'path is required in body' });
    if (content === undefined) return res.status(400).json({ error: 'content is required' });

    const provider = await getWorkspaceProviderForRequest(req);
    const result = await provider.writeFile(relPath, content);
    return res.json(result);
  } catch (err) {
    return handleProviderError(err, res);
  }
});

// POST /api/v1/artifacts/mkdir?path=...
router.post('/mkdir', async (req: Request, res: Response) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) return res.status(400).json({ error: 'path query param required' });

    const provider = await getWorkspaceProviderForRequest(req);
    const result = await provider.mkdir(relPath);
    return res.json(result);
  } catch (err) {
    return handleProviderError(err, res);
  }
});

// GET /api/v1/artifacts/raw?path=...  — serves the file with proper Content-Type
router.get('/raw', async (req: Request, res: Response) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) return res.status(400).json({ error: 'path query param required' });

    const provider = await getWorkspaceProviderForRequest(req);
    const raw = await provider.rawFile(relPath);

    res.setHeader('Content-Type', raw.mime);
    res.setHeader('Cache-Control', 'no-cache');

    if (raw.stream) {
      if (raw.size !== undefined) {
        res.setHeader('Content-Length', raw.size);
      }
      raw.stream.pipe(res);
      return;
    }

    if (raw.buffer !== undefined) {
      return res.send(raw.buffer);
    }

    return res.status(404).json({ error: 'File content not available' });
  } catch (err) {
    return handleProviderError(err, res);
  }
});

// POST /api/v1/artifacts/rename — rename/move a file
router.post('/rename', async (req: Request, res: Response) => {
  try {
    const { oldPath, newPath } = req.body as { oldPath?: string; newPath?: string };
    if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });

    const provider = await getWorkspaceProviderForRequest(req);
    const result = await provider.rename(oldPath, newPath);
    return res.json(result);
  } catch (err) {
    return handleProviderError(err, res);
  }
});

// DELETE /api/v1/artifacts/file?path=...
router.delete('/file', async (req: Request, res: Response) => {
  try {
    const relPath = req.query.path as string;
    if (!relPath) return res.status(400).json({ error: 'path query param required' });

    const provider = await getWorkspaceProviderForRequest(req);
    const result = await provider.deleteFile(relPath);
    return res.json(result);
  } catch (err) {
    return handleProviderError(err, res);
  }
});

export default router;
