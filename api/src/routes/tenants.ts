import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/client';
import {
  createTenantWithDefaults,
  deleteTenant,
  getActiveTenantId,
  listTenants,
  setActiveTenantId,
} from '../lib/tenantContext';
import { applyDefaultInstallPackage } from '../lib/defaultInstallPackage';

const router = Router();

function sendError(res: Response, err: unknown): Response {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
  return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    return res.json({ tenants: listTenants(db), active_tenant_id: getActiveTenantId(db) });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenant = createTenantWithDefaults(db, req.body ?? {});
    return res.status(201).json({ tenant, active_tenant_id: getActiveTenantId(db) });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/active', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const activeTenantId = getActiveTenantId(db);
    const tenant = db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(activeTenantId);
    return res.json({ tenant, active_tenant_id: activeTenantId });
  } catch (err) {
    return sendError(res, err);
  }
});

router.put('/active', (req: Request, res: Response) => {
  try {
    const db = getDb();
    // company_id is a deprecated compatibility alias; tenant_id is canonical.
    const rawTenantId = req.body?.tenant_id ?? req.body?.company_id;
    const tenantId = Number(rawTenantId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }
    const tenant = setActiveTenantId(db, tenantId);
    return res.json({ tenant, active_tenant_id: tenantId });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/:id/select', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = Number(req.params.id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: 'Tenant id must be a positive integer' });
    }
    const tenant = setActiveTenantId(db, tenantId);
    return res.json({ tenant, active_tenant_id: tenantId });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/:id/default-package/reinstall', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = Number(req.params.id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: 'Tenant id must be a positive integer' });
    }
    const tenant = db.prepare(`SELECT id FROM tenants WHERE id = ? LIMIT 1`).get(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const result = applyDefaultInstallPackage(db, tenantId, { mode: 'reinstall' });
    return res.json({ ok: true, result });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = Number(req.params.id);
    // company_name is a deprecated compatibility alias; confirmation is canonical.
    const result = deleteTenant(db, tenantId, { confirmation: req.body?.confirmation ?? req.body?.company_name });
    return res.json({
      ...result,
      tenants: listTenants(db),
    });
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
