import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { THINKING_LEVELS } from '../lib/workflowVocabulary';
import { columnExists as sharedColumnExists, tableExists as sharedTableExists } from "../db/introspection";

const router = Router();
const ALLOWED_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);

async function hasColumn(db: ReturnType<typeof getDb>, table: string, column: string): Promise<boolean> {
  try {
    return await sharedColumnExists(db, `${table}`, column);
  } catch {
    return false;
  }
}

function normalizeNullableText(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  const text = typeof value === 'string' ? value.trim() : String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeOptionalNullableText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = typeof value === 'string' ? value.trim() : String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeOptionalPositiveInt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new Error('Expected a positive integer');
  }
  return num;
}

function normalizeOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error('Expected a number');
  }
  return num;
}

function normalizeOptionalBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  throw badRequest('fast_mode must be true, false, or null');
}

function normalizeOptionalEnabled(value: unknown, fallback = true): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'enabled') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'disabled') return false;
  }
  throw badRequest('enabled must be true or false');
}

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function normalizeOptionalThinkingLevel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const thinking = typeof value === 'string' ? value.trim().toLowerCase() : String(value).trim().toLowerCase();
  if (!ALLOWED_THINKING_LEVELS.has(thinking)) {
    throw badRequest(`thinking_level must be one of: ${Array.from(ALLOWED_THINKING_LEVELS).join(', ')}`);
  }
  return thinking;
}

function normalizeOptionalProvider(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const provider = typeof value === 'string' ? value.trim() : String(value).trim();
  return provider.length > 0 ? provider : null;
}

function normalizeScopeId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw badRequest('project_id and workflow_id must be positive integers when provided');
  }
  return num;
}

function normalizeSprintType(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim() : String(value).trim();
  return text.length > 0 ? text : null;
}

function coalesceAlias<T>(
  canonicalValue: T | undefined,
  aliasValue: T | undefined,
  canonicalName: string,
  aliasName: string,
): T | undefined {
  if (canonicalValue !== undefined && aliasValue !== undefined && canonicalValue !== aliasValue) {
    throw badRequest(`${aliasName} conflicts with ${canonicalName}`);
  }
  return canonicalValue !== undefined ? canonicalValue : aliasValue;
}

function normalizeWorkflowScopeInput(input: Record<string, unknown>): {
  project_id: number | null | undefined;
  sprint_id: number | null | undefined;
  sprint_type: string | null | undefined;
} {
  const sprintId = coalesceAlias(
    normalizeScopeId(input.sprint_id),
    normalizeScopeId(input.workflow_id),
    'sprint_id',
    'workflow_id',
  );
  const sprintType = coalesceAlias(
    normalizeSprintType(input.sprint_type),
    normalizeSprintType(input.workflow_type),
    'sprint_type',
    'workflow_type',
  );
  return {
    project_id: normalizeScopeId(input.project_id),
    sprint_id: sprintId,
    sprint_type: sprintType,
  };
}

async function resolveScope(
  db: ReturnType<typeof getDb>,
  tenantId: number,
  projectId: number | null | undefined,
  sprintId: number | null | undefined,
  sprintType: string | null | undefined,
): Promise<{ project_id: number | null; sprint_id: number | null; sprint_type: string | null }> {
  if (projectId == null && sprintId == null && sprintType == null) {
    return { project_id: null, sprint_id: null, sprint_type: null };
  }

  let resolvedProjectId = projectId ?? null;
  let resolvedSprintId = sprintId ?? null;
  let resolvedSprintType = sprintType ?? null;

  if (resolvedProjectId != null) {
    const project = await hasColumn(db, 'projects', 'tenant_id')
      ? await db.get(`SELECT id FROM projects WHERE id = ? AND tenant_id = ?`, resolvedProjectId, tenantId) as { id: number } | undefined
      : await db.get(`SELECT id FROM projects WHERE id = ?`, resolvedProjectId) as { id: number } | undefined;
    if (!project) throw badRequest('project_id must reference an existing project');
  }

  if (resolvedSprintId != null) {
    const sprint = await hasColumn(db, 'sprints', 'tenant_id')
      ? await db.get(`SELECT id, project_id, sprint_type FROM sprints WHERE id = ? AND tenant_id = ?`, resolvedSprintId, tenantId) as { id: number; project_id: number | null; sprint_type?: string | null } | undefined
      : await db.get(`SELECT id, project_id, sprint_type FROM sprints WHERE id = ?`, resolvedSprintId) as { id: number; project_id: number | null; sprint_type?: string | null } | undefined;
    if (!sprint) throw badRequest('workflow_id must reference an existing workflow');
    if (resolvedProjectId != null && sprint.project_id !== resolvedProjectId) {
      throw badRequest('workflow_id must belong to project_id');
    }
    const sprintTypeFromSprint = sprint.sprint_type ? String(sprint.sprint_type).trim() : null;
    if (resolvedSprintType != null && sprintTypeFromSprint !== resolvedSprintType) {
      throw badRequest(`workflow_id must use workflow_type "${resolvedSprintType}"`);
    }
    resolvedProjectId = resolvedProjectId ?? sprint.project_id ?? null;
    resolvedSprintType = resolvedSprintType ?? sprintTypeFromSprint;
  }

  if (resolvedSprintType != null) {
    const sprintTypeRow = await db.get(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`, resolvedSprintType) as { key?: string } | undefined;
    if (!sprintTypeRow) throw badRequest(`workflow_type must reference an existing workflow type; "${resolvedSprintType}" was not found`);
  }

  return { project_id: resolvedProjectId, sprint_id: resolvedSprintId, sprint_type: resolvedSprintType };
}

async function providerConfigTableExists(db: ReturnType<typeof getDb>): Promise<boolean> {
  return await sharedTableExists(db, 'provider_config');
}

async function assertConfiguredProvider(db: ReturnType<typeof getDb>, tenantId: number, provider: string | null | undefined): Promise<void> {
  if (provider == null) return;
  if (!await providerConfigTableExists(db)) {
    throw badRequest('provider_config table is required to validate model routing providers');
  }

  const row = await db.get(`SELECT slug FROM provider_config WHERE slug = ? AND tenant_id = ?`, provider, tenantId) as { slug: string } | undefined;
  if (!row) {
    throw badRequest(`provider must be a configured provider slug or null; "${provider}" is not configured`);
  }
}

function assertCanonicalOpenClawModelId(model: string | null | undefined, field: string): void {
  if (model?.startsWith('openai-codex/')) {
    throw badRequest(`${field} must use OpenClaw model IDs such as "openai/gpt-5.5"; openai-codex is an auth provider slug, not a model provider prefix`);
  }
}

function normalizeModelRoutingPayload(body: Record<string, unknown>, mode: 'create' | 'update') {
  const minStoryPoints = normalizeOptionalPositiveInt(body.min_story_points);
  const maxStoryPoints = normalizeOptionalPositiveInt(body.max_story_points);
  const maxPoints = normalizeOptionalPositiveInt(body.max_points);
  const provider = normalizeOptionalProvider(body.provider);
  const model = normalizeNullableText(body.model);
  const fallbackModel = normalizeOptionalNullableText(body.fallback_model);
  assertCanonicalOpenClawModelId(model, 'model');
  assertCanonicalOpenClawModelId(fallbackModel, 'fallback_model');
  const maxTurns = normalizeOptionalPositiveInt(body.max_turns);
  const maxBudgetUsd = normalizeOptionalNumber(body.max_budget_usd);
  const thinkingLevel = normalizeOptionalThinkingLevel(body.thinking_level);
  const fastMode = normalizeOptionalBoolean(body.fast_mode);
  const enabled = mode === 'create'
    ? normalizeOptionalEnabled(body.enabled, true)
    : (body.enabled === undefined ? undefined : normalizeOptionalEnabled(body.enabled, true));
  const label = normalizeOptionalNullableText(body.label);
  const priority = normalizeOptionalPositiveInt(body.priority);
  const { project_id: projectId, sprint_id: sprintId, sprint_type: sprintType } = normalizeWorkflowScopeInput(body);

  if (maxStoryPoints != null && minStoryPoints != null && maxStoryPoints < minStoryPoints) {
    throw badRequest('max_story_points must be greater than or equal to min_story_points');
  }

  const resolvedMaxPoints = maxPoints ?? maxStoryPoints;
  if (mode === 'create' && (resolvedMaxPoints == null || !model)) {
    throw badRequest('max_points and model are required (aliases: max_story_points for max_points)');
  }

  return {
    min_story_points: minStoryPoints,
    max_points: resolvedMaxPoints,
    max_story_points: maxStoryPoints,
    provider,
    model: model ?? undefined,
    fallback_model: fallbackModel,
    max_turns: maxTurns,
    max_budget_usd: maxBudgetUsd,
    thinking_level: thinkingLevel,
    fast_mode: fastMode,
    enabled,
    label,
    priority,
    project_id: projectId,
    sprint_id: sprintId,
    sprint_type: sprintType,
  };
}

function requireExplicitScope(scope: { project_id: number | null; sprint_id: number | null; sprint_type: string | null }): { project_id: number | null; sprint_id: number | null; sprint_type: string | null } {
  if (scope.project_id == null && scope.sprint_id == null && scope.sprint_type == null) {
    throw badRequest('Explicit project_id, workflow_id, or workflow_type scope is required; legacy global model routing rules are no longer supported');
  }
  return scope;
}

function serializeRule(rule: Record<string, unknown>) {
  const maxPoints = Number(rule.max_points);
  const payload = {
    ...rule,
    max_story_points: Number.isFinite(maxPoints) ? maxPoints : rule.max_points,
  } as Record<string, unknown>;
  if (!('min_story_points' in payload) || payload.min_story_points == null) payload.min_story_points = 1;
  if (!('project_id' in payload)) payload.project_id = null;
  if (!('sprint_id' in payload)) payload.sprint_id = null;
  if (!('sprint_type' in payload)) payload.sprint_type = null;
  if ('fast_mode' in payload && payload.fast_mode != null) payload.fast_mode = Boolean(payload.fast_mode);
  if ('enabled' in payload && payload.enabled != null) payload.enabled = Boolean(payload.enabled);
  if (!('enabled' in payload)) payload.enabled = true;
  payload.workflow_id = payload.sprint_id;
  payload.workflow_type = payload.sprint_type;
  payload.scope = payload.sprint_id
    ? 'project_sprint'
    : (payload.sprint_type ? (payload.project_id ? 'project_sprint_type' : 'sprint_type') : (payload.project_id ? 'project' : 'legacy_global'));
  return payload;
}

async function readRuleById(db: ReturnType<typeof getDb>, id: number, tenantId: number) {
  if (await hasColumn(db, 'story_point_model_routing', 'tenant_id')) {
    return await db.get(`SELECT * FROM story_point_model_routing WHERE id = ? AND tenant_id = ?`, id, tenantId);
  }
  return await db.get(`SELECT * FROM story_point_model_routing WHERE id = ?`, id);
}

// GET /api/v1/model-routing — list rules, optionally filtered by project+sprint scope
router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const hasProjectScope = await hasColumn(db, 'story_point_model_routing', 'project_id');
    const hasSprintScope = await hasColumn(db, 'story_point_model_routing', 'sprint_id');
    const hasSprintTypeScope = await hasColumn(db, 'story_point_model_routing', 'sprint_type');
    const {
      project_id: queryProjectId,
      sprint_id: querySprintId,
      sprint_type: querySprintType,
    } = normalizeWorkflowScopeInput(req.query as Record<string, unknown>);
    const hasScopeQuery = queryProjectId !== undefined || querySprintId !== undefined || querySprintType !== undefined;
    if (req.query.include_fallback === 'true' || req.query.include_fallback === '1') {
      throw badRequest('include_fallback is no longer supported; configure explicit scoped model routing rules instead');
    }
    const scope = hasScopeQuery ? await resolveScope(db, tenantId, queryProjectId, querySprintId, querySprintType) : null;
    const params: unknown[] = [];
    const where: string[] = [];
    if (await hasColumn(db, 'story_point_model_routing', 'tenant_id')) {
      where.push('tenant_id = ?');
      params.push(tenantId);
    }

    if (hasScopeQuery && hasProjectScope && hasSprintScope && scope) {
      if (scope.project_id == null) {
        where.push('project_id IS NULL');
      } else {
        where.push('project_id = ?');
        params.push(scope.project_id);
      }
      if (scope.sprint_id == null) {
        where.push('sprint_id IS NULL');
      } else {
        where.push('sprint_id = ?');
        params.push(scope.sprint_id);
      }
      if (hasSprintTypeScope) {
        if (scope.sprint_id != null || scope.sprint_type == null) {
          where.push('sprint_type IS NULL');
        } else {
          where.push('sprint_type = ?');
          params.push(scope.sprint_type);
        }
      }
    }

    const scopeOrder = hasProjectScope && hasSprintScope
      ? `project_id IS NULL ASC, sprint_id IS NULL ASC, ${hasSprintTypeScope ? 'sprint_type IS NULL ASC, sprint_type ASC,' : ''} project_id ASC, sprint_id ASC,`
      : '';
    const rules = await db.all(`
      SELECT * FROM story_point_model_routing
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${scopeOrder} max_points ASC
    `, ...params) as Record<string, unknown>[];
    return res.json(rules.map((rule) => serializeRule(rule)));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/v1/model-routing/:id — fetch a single canonical routing rule
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const rule = await readRuleById(db, Number(req.params.id), tenantId) as Record<string, unknown> | undefined;
    if (!rule) return res.status(404).json({ error: 'Routing rule not found' });
    return res.json(serializeRule(rule));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/v1/model-routing — create a rule
router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const payload = normalizeModelRoutingPayload((req.body ?? {}) as Record<string, unknown>, 'create');
    const provider = payload.provider !== undefined ? payload.provider : null;
    await assertConfiguredProvider(db, tenantId, provider);
    const supportsScope = await hasColumn(db, 'story_point_model_routing', 'project_id') && await hasColumn(db, 'story_point_model_routing', 'sprint_id');
    const supportsSprintTypeScope = await hasColumn(db, 'story_point_model_routing', 'sprint_type');
    if (!supportsScope) {
      throw badRequest('Scoped model routing columns are required; legacy global-only model routing is no longer supported');
    }
    if (payload.sprint_type !== undefined && !supportsSprintTypeScope) {
      throw badRequest('workflow_type scoped model routing requires the sprint_type schema migration');
    }
    const scope = requireExplicitScope(await resolveScope(db, tenantId, payload.project_id, payload.sprint_id, payload.sprint_type));

    const result = supportsScope && supportsSprintTypeScope
      ? await db.run(`
          INSERT INTO story_point_model_routing
            (tenant_id, project_id, sprint_id, sprint_type, max_points, provider, model, fallback_model, max_turns, max_budget_usd, thinking_level, fast_mode, enabled, label)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, tenantId, scope.project_id, scope.sprint_id, scope.sprint_id == null ? scope.sprint_type : null, payload.max_points, provider, payload.model, payload.fallback_model ?? null, payload.max_turns ?? null, payload.max_budget_usd ?? null, payload.thinking_level ?? null, payload.fast_mode == null ? null : (payload.fast_mode ? 1 : 0), payload.enabled ? 1 : 0, payload.label ?? null)
      : await db.run(`
          INSERT INTO story_point_model_routing
            (max_points, provider, model, fallback_model, max_turns, max_budget_usd, thinking_level, fast_mode, enabled, label)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, payload.max_points, provider, payload.model, payload.fallback_model ?? null, payload.max_turns ?? null, payload.max_budget_usd ?? null, payload.thinking_level ?? null, payload.fast_mode == null ? null : (payload.fast_mode ? 1 : 0), payload.enabled ? 1 : 0, payload.label ?? null);

    const created = await db.get(`SELECT * FROM story_point_model_routing WHERE id = ?`, result.lastInsertId) as Record<string, unknown> | undefined;
    return res.status(201).json(serializeRule(created ?? {}));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// PUT /api/v1/model-routing/:id — update a rule
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await readRuleById(db, Number(req.params.id), tenantId) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    const payload = normalizeModelRoutingPayload((req.body ?? {}) as Record<string, unknown>, 'update');
    const provider = payload.provider !== undefined
      ? payload.provider
      : (existing.provider as string | null | undefined) ?? null;
    await assertConfiguredProvider(db, tenantId, provider);
    const supportsScope = await hasColumn(db, 'story_point_model_routing', 'project_id') && await hasColumn(db, 'story_point_model_routing', 'sprint_id');
    const supportsSprintTypeScope = await hasColumn(db, 'story_point_model_routing', 'sprint_type');
    if (!supportsScope) {
      throw badRequest('Scoped model routing columns are required; legacy global-only model routing is no longer supported');
    }
    if (payload.sprint_type !== undefined && !supportsSprintTypeScope) {
      throw badRequest('workflow_type scoped model routing requires the sprint_type schema migration');
    }
    const scope = requireExplicitScope(await resolveScope(
              db,
              tenantId,
              payload.project_id !== undefined ? payload.project_id : (existing.project_id as number | null | undefined) ?? null,
              payload.sprint_id !== undefined ? payload.sprint_id : (existing.sprint_id as number | null | undefined) ?? null,
              payload.sprint_type !== undefined ? payload.sprint_type : (existing.sprint_type as string | null | undefined) ?? null,
            ));

    if (supportsScope && supportsSprintTypeScope) {
      await db.run(`
        UPDATE story_point_model_routing SET
          project_id     = ?,
          sprint_id      = ?,
          sprint_type    = ?,
          max_points     = ?,
          provider       = ?,
          model          = ?,
          fallback_model = ?,
          max_turns      = ?,
          max_budget_usd = ?,
          thinking_level = ?,
          fast_mode      = ?,
          enabled        = ?,
          label          = ?,
          updated_at     = datetime('now')
        WHERE id = ?
      `, scope.project_id, scope.sprint_id, scope.sprint_id == null ? scope.sprint_type : null, payload.max_points     !== undefined ? payload.max_points     : existing.max_points, provider, payload.model          !== undefined ? payload.model          : existing.model, payload.fallback_model !== undefined ? payload.fallback_model : existing.fallback_model, payload.max_turns      !== undefined ? payload.max_turns      : existing.max_turns, payload.max_budget_usd !== undefined ? payload.max_budget_usd : existing.max_budget_usd, payload.thinking_level !== undefined ? payload.thinking_level : existing.thinking_level, payload.fast_mode      !== undefined ? (payload.fast_mode == null ? null : (payload.fast_mode ? 1 : 0)) : existing.fast_mode, payload.enabled        !== undefined ? (payload.enabled ? 1 : 0) : existing.enabled ?? 1, payload.label          !== undefined ? payload.label          : existing.label, req.params.id);
    } else {
      await db.run(`
        UPDATE story_point_model_routing SET
          max_points     = ?,
          provider       = ?,
          model          = ?,
          fallback_model = ?,
          max_turns      = ?,
          max_budget_usd = ?,
          thinking_level = ?,
          fast_mode      = ?,
          enabled        = ?,
          label          = ?,
          updated_at     = datetime('now')
        WHERE id = ?
      `, payload.max_points     !== undefined ? payload.max_points     : existing.max_points, provider, payload.model          !== undefined ? payload.model          : existing.model, payload.fallback_model !== undefined ? payload.fallback_model : existing.fallback_model, payload.max_turns      !== undefined ? payload.max_turns      : existing.max_turns, payload.max_budget_usd !== undefined ? payload.max_budget_usd : existing.max_budget_usd, payload.thinking_level !== undefined ? payload.thinking_level : existing.thinking_level, payload.fast_mode      !== undefined ? (payload.fast_mode == null ? null : (payload.fast_mode ? 1 : 0)) : existing.fast_mode, payload.enabled        !== undefined ? (payload.enabled ? 1 : 0) : existing.enabled ?? 1, payload.label          !== undefined ? payload.label          : existing.label, req.params.id);
    }

    const updated = await readRuleById(db, Number(req.params.id), tenantId) as Record<string, unknown> | undefined;
    return res.json(serializeRule(updated ?? {}));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// DELETE /api/v1/model-routing/:id — delete a rule
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await readRuleById(db, Number(req.params.id), tenantId);
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    if (await hasColumn(db, 'story_point_model_routing', 'tenant_id')) {
      await db.run(`DELETE FROM story_point_model_routing WHERE id = ? AND tenant_id = ?`, req.params.id, tenantId);
    } else {
      await db.run(`DELETE FROM story_point_model_routing WHERE id = ?`, req.params.id);
    }
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
