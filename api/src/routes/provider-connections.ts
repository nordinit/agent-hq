import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { listProviderDefinitions } from '../domains/providers/registry';
import { tableColumns as sharedTableColumns } from "../db/introspection";
import {
  getRuntimeProviderAdapter,
  listRuntimeProviderCapabilities,
} from '../domains/providers/runtimeAdapters';

const router = Router();

interface ConnectionRow {
  id: number;
  tenant_id: number;
  provider_slug: string;
  auth_mode: string;
  runtime_type: string;
  external_ref: string;
  display_name: string;
  status: string;
  metadata: string;
  last_validated_at: string | null;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serialize(row: ConnectionRow) {
  return { ...row, metadata: parseMetadata(row.metadata) };
}

function containsSecretMetadata(value: unknown, key = ''): boolean {
  const normalizedKey = key.trim().toLowerCase();
  if (normalizedKey !== 'credential_owner' && /(^|[_-])(token|secret|password|credential|api[_-]?key|access[_-]?token|refresh[_-]?token)([_-]|$)/i.test(normalizedKey)) return true;
  if (Array.isArray(value)) return value.some(item => containsSecretMetadata(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([childKey, child]) => containsSecretMetadata(child, childKey));
}

router.get('/registry', (_req: Request, res: Response) => {
  res.json({ providers: listProviderDefinitions(), capabilities: listRuntimeProviderCapabilities() });
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const rows = await db.all(`
      SELECT * FROM provider_connections
      WHERE tenant_id = ?
      ORDER BY runtime_type, provider_slug, display_name, id
    `, tenantId) as ConnectionRow[];
    res.json({ connections: rows.map(serialize) });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post('/auth-instructions', (req: Request, res: Response) => {
  const provider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
  const runtime = typeof req.body?.runtime === 'string' ? req.body.runtime.trim() : '';
  const authMode = typeof req.body?.auth_mode === 'string' ? req.body.auth_mode.trim() : '';
  const adapter = getRuntimeProviderAdapter(runtime, provider, authMode);
  if (!adapter) {
    res.status(400).json({ error: `No provider adapter supports ${runtime}/${provider}/${authMode}.` });
    return;
  }
  res.json({ capability: adapter.capability, instructions: adapter.authInstructions() });
});

router.post('/discover', async (req: Request, res: Response) => {
  try {
    const provider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
    const runtime = typeof req.body?.runtime === 'string' ? req.body.runtime.trim() : '';
    const authMode = typeof req.body?.auth_mode === 'string' ? req.body.auth_mode.trim() : '';
    const runtimeConfig = isRecord(req.body?.runtime_config) ? req.body.runtime_config : null;
    const agentSlug = typeof req.body?.agent_slug === 'string' ? req.body.agent_slug.trim() : null;
    const adapter = getRuntimeProviderAdapter(runtime, provider, authMode);
    if (!adapter) {
      res.status(400).json({ error: `No provider adapter supports ${runtime}/${provider}/${authMode}.` });
      return;
    }
    const connections = await adapter.discover({ agentSlug, runtimeConfig });
    res.json({ capability: adapter.capability, connections });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const provider = typeof req.body?.provider_slug === 'string' ? req.body.provider_slug.trim() : '';
    const runtime = typeof req.body?.runtime_type === 'string' ? req.body.runtime_type.trim() : '';
    const authMode = typeof req.body?.auth_mode === 'string' ? req.body.auth_mode.trim() : '';
    const externalRef = typeof req.body?.external_ref === 'string' ? req.body.external_ref.trim() : '';
    const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
    const metadata = isRecord(req.body?.metadata) ? req.body.metadata : {};
    const runtimeConfig = isRecord(req.body?.runtime_config) ? req.body.runtime_config : null;
    const agentSlug = typeof req.body?.agent_slug === 'string' ? req.body.agent_slug.trim() : null;
    if (!provider || !runtime || !authMode || !externalRef) {
      res.status(400).json({ error: 'provider_slug, runtime_type, auth_mode, and external_ref are required.' });
      return;
    }
    if (containsSecretMetadata(metadata)) {
      res.status(400).json({ error: 'Provider connection metadata must not contain tokens, credentials, passwords, secrets, or API keys.' });
      return;
    }
    const adapter = getRuntimeProviderAdapter(runtime, provider, authMode);
    if (!adapter) {
      res.status(400).json({ error: `No provider adapter supports ${runtime}/${provider}/${authMode}.` });
      return;
    }
    const discovered = await adapter.discover({ agentSlug, runtimeConfig });
    const match = discovered.find(connection => connection.externalRef === externalRef);
    if (!match) {
      res.status(400).json({
        error: `Runtime credential reference '${externalRef}' was not discovered. Complete runtime authentication and refresh discovery first.`,
      });
      return;
    }

    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const mergedMetadata = { ...match.metadata, ...metadata };
    const existing = await db.get(`
      SELECT id FROM provider_connections
      WHERE tenant_id = ? AND runtime_type = ? AND provider_slug = ? AND auth_mode = ? AND external_ref = ?
    `, tenantId, runtime, provider, authMode, externalRef) as { id: number } | undefined;
    let id: number;
    if (existing) {
      await db.run(`
        UPDATE provider_connections
        SET display_name = ?, status = 'connected', metadata = ?, last_validated_at = datetime('now'),
            validation_error = NULL, updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?
      `, displayName || match.displayName, JSON.stringify(mergedMetadata), existing.id, tenantId);
      id = existing.id;
    } else {
      const result = await db.run(`
        INSERT INTO provider_connections (
          tenant_id, provider_slug, auth_mode, runtime_type, external_ref, display_name,
          status, metadata, last_validated_at, validation_error
        ) VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, datetime('now'), NULL)
      `, tenantId, provider, authMode, runtime, externalRef, displayName || match.displayName, JSON.stringify(mergedMetadata));
      id = Number(result.lastInsertId);
    }
    const row = await db.get('SELECT * FROM provider_connections WHERE id = ? AND tenant_id = ?', id, tenantId) as ConnectionRow;
    res.status(existing ? 200 : 201).json(serialize(row));
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post('/:id/validate', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const row = await db.get('SELECT * FROM provider_connections WHERE id = ? AND tenant_id = ?', req.params.id, tenantId) as ConnectionRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Provider connection not found.' });
      return;
    }
    const adapter = getRuntimeProviderAdapter(row.runtime_type, row.provider_slug, row.auth_mode);
    if (!adapter) {
      res.status(400).json({ error: `No provider adapter supports ${row.runtime_type}/${row.provider_slug}/${row.auth_mode}.` });
      return;
    }
    const metadata = parseMetadata(row.metadata);
    const runtimeConfig = isRecord(req.body?.runtime_config) ? req.body.runtime_config : metadata;
    const agentSlug = typeof metadata.agent_slug === 'string' ? metadata.agent_slug : null;
    const discovered = await adapter.discover({ agentSlug, runtimeConfig });
    const match = discovered.find(connection => connection.externalRef === row.external_ref);
    const status = match ? 'connected' : 'failed';
    const validationError = match ? null : 'The runtime no longer reports this credential reference. Re-authenticate in the runtime.';
    await db.run(`
      UPDATE provider_connections
      SET status = ?, last_validated_at = datetime('now'), validation_error = ?, updated_at = datetime('now')
      WHERE id = ? AND tenant_id = ?
    `, status, validationError, row.id, tenantId);
    res.status(match ? 200 : 409).json({ ok: Boolean(match), status, error: validationError });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await db.get('SELECT id FROM provider_connections WHERE id = ? AND tenant_id = ?', req.params.id, tenantId) as { id: number } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Provider connection not found.' });
      return;
    }
    const agentColumns = (await sharedTableColumns(db, 'agents')).map((name) => ({ name }));
    if (agentColumns.some(column => column.name === 'provider_connection_id')) {
      await db.run('UPDATE agents SET provider_connection_id = NULL WHERE provider_connection_id = ? AND tenant_id = ?', existing.id, tenantId);
    }
    await db.run('DELETE FROM provider_connections WHERE id = ? AND tenant_id = ?', existing.id, tenantId);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;
