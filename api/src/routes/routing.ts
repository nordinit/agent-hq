import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import {
  CONTRACT_PLACEHOLDER_DEFINITIONS,
  getAvailableContractPlaceholders,
  normalizeContractTemplateKey,
  readSprintTypeContractTemplate,
  writeSprintTypeContractTemplate,
} from '../services/contracts';
import { VALID_TASK_TYPES } from '../lib/taskTypes';
import {
  getAllowedTaskTypesForSprintType,
  resolveSprintTypeForSprintId,
} from '../domains/sprint-definitions/config';
import { getNeedsAttentionEligibleStatuses, setNeedsAttentionEligibleStatuses } from '../lib/reconcilerConfig';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import {
  createRoutingRule,
  createRoutingStatus,
  createRoutingTransition,
  createTransitionRequirement,
  deleteRoutingRule,
  deleteRoutingStatus,
  deleteRoutingTransition,
  deleteTransitionRequirement,
  getRoutingTransition,
  getRoutingRule,
  listRoutingRulesForSprint,
  listRoutingStatuses,
  listRoutingTransitions,
  listTransitionRequirementFields,
  listTransitionRequirements,
  resolveRoutingRuleForSprint,
  updateRoutingRule,
  updateRoutingStatus,
  updateRoutingTransition,
  updateTransitionRequirement,
} from '../domains/routing/admin';
import {
  createWorkflowEventMapping,
  deleteWorkflowEventMapping,
  getWorkflowEventMapping,
  listWorkflowEventMappings,
  updateWorkflowEventMapping,
  createExternalEventMapping,
  deleteExternalEventMapping,
  getExternalEventMapping,
  listExternalEventMappings,
  updateExternalEventMapping,
} from '../domains/routing/externalEventMappings';

const router = Router();

function sendRoutingError(res: Response, err: unknown): Response {
  const status = (err as Error & { status?: number }).status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  const extras = Object.fromEntries(
    Object.entries(err as Record<string, unknown>).filter(([key]) => !['message', 'status', 'stack', 'name'].includes(key)),
  );
  return res.status(status).json({ error: message, ...extras });
}

function normalizeWorkflowAliases(input: unknown): Record<string, unknown> {
  const source = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const normalized = { ...source };
  if (normalized.workflow_id !== undefined) {
    if (normalized.sprint_id !== undefined && String(normalized.sprint_id) !== String(normalized.workflow_id)) {
      throw Object.assign(new Error('workflow_id conflicts with sprint_id'), { status: 400 });
    }
    normalized.sprint_id = normalized.workflow_id;
  }
  if (normalized.workflow_type !== undefined) {
    if (normalized.sprint_type !== undefined && String(normalized.sprint_type) !== String(normalized.workflow_type)) {
      throw Object.assign(new Error('workflow_type conflicts with sprint_type'), { status: 400 });
    }
    normalized.sprint_type = normalized.workflow_type;
  }
  return normalized;
}

function isDryRunInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const value = (input as Record<string, unknown>).dry_run;
  return value === true || value === 'true';
}

function dryRunConfigWrite<T>(
  action: 'create' | 'update' | 'delete',
  table: string,
  input: Record<string, unknown>,
  run: () => T,
): T | { dry_run: true; preview: { action: string; table: string; affected: T; input: Record<string, unknown> } } {
  if (!isDryRunInput(input)) return run();
  const db = getDb();
  db.exec('SAVEPOINT dry_run_config_write');
  try {
    const affected = run();
    db.exec('ROLLBACK TO dry_run_config_write');
    db.exec('RELEASE dry_run_config_write');
    return {
      dry_run: true,
      preview: {
        action,
        table,
        affected,
        input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'dry_run')),
      },
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK TO dry_run_config_write');
      db.exec('RELEASE dry_run_config_write');
    } catch {
      // Preserve the original validation error.
    }
    throw err;
  }
}

function mergeWorkflowAliasInputs(query: unknown, body?: unknown): Record<string, unknown> {
  return { ...normalizeWorkflowAliases(query), ...normalizeWorkflowAliases(body) };
}

function withRequestTenant<T extends Record<string, unknown>>(req: Request, input: T): T & { tenant_id: number } {
  const db = getDb();
  const tenantId = resolveTenantIdFromRequest(db, req);
  return { ...input, tenant_id: tenantId };
}

function routeTableHasColumn(table: string, column: string): boolean {
  try {
    const db = getDb();
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING CONFIG — per-job settings
// ═══════════════════════════════════════════════════════════════════════════════

// GET /config — routing config for all agents
// Task #596: Reads from agents table directly (routing_config_legacy removed).
router.get('/config', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const tenantWhere = routeTableHasColumn('agents', 'tenant_id') ? 'AND a.tenant_id = ?' : '';
    // Primary source: agents table (Phase 4 target)
    const configs = db.prepare(`
      SELECT a.id as agent_id, a.name as agent_name, a.job_title,
             a.stall_threshold_min, a.max_retries, a.sort_rules
      FROM agents a
      WHERE a.enabled = 1
        ${tenantWhere}
      ORDER BY a.id
    `).all(...(tenantWhere ? [tenantId] : []));

    const parsed = (configs as any[]).map(c => ({
      ...c,
      sort_rules: (() => { try { return JSON.parse(c.sort_rules || '[]'); } catch { return []; } })(),
    }));

    res.json({ configs: parsed });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/reconciler-config', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    res.json({
      needs_attention_eligible_statuses: getNeedsAttentionEligibleStatuses(db),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/reconciler-config', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const statuses = setNeedsAttentionEligibleStatuses(db, req.body?.needs_attention_eligible_statuses);
    res.json({ needs_attention_eligible_statuses: statuses });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /config/:job_id — single routing config (accepts job_id or agent_id)
// Task #594: Reads from agents table. job_id is resolved to agent_id for compat.
router.get('/config/:job_id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agentTenantWhere = routeTableHasColumn('agents', 'tenant_id') ? 'AND tenant_id = ?' : '';
    const agentTenantParams = agentTenantWhere ? [tenantId] : [];
    const paramId = Number(req.params.job_id);

    // Try agent_id directly
    const agent = db.prepare(`
      SELECT id as agent_id, name as agent_name, job_title,
             stall_threshold_min, max_retries, sort_rules
      FROM agents WHERE id = ? ${agentTenantWhere}
    `).get(paramId, ...agentTenantParams) as any;

    if (!agent) {
      return res.status(404).json({ error: `No routing config for id=${paramId}` });
    }

    agent.sort_rules = (() => { try { return JSON.parse(agent.sort_rules || '[]'); } catch { return []; } })();

    res.json(agent);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /config/:job_id — update routing config (accepts job_id or agent_id)
// Task #596: Writes to agents table (routing_config_legacy removed).
router.put('/config/:job_id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agentTenantWhere = routeTableHasColumn('agents', 'tenant_id') ? 'AND tenant_id = ?' : '';
    const agentTenantParams = agentTenantWhere ? [tenantId] : [];
    const paramId = Number(req.params.job_id);
    const { stall_threshold_min, max_retries, sort_rules } = req.body;

    // Resolve to agent_id
    const agentDirect = db.prepare(`SELECT id FROM agents WHERE id = ? ${agentTenantWhere}`).get(paramId, ...agentTenantParams) as { id: number } | undefined;
    const agentId: number | null = agentDirect?.id ?? null;

    if (!agentId) {
      return res.status(404).json({ error: `Agent or job ${paramId} not found` });
    }

    // Update agents table (primary)
    const sets: string[] = [];
    const vals: any[] = [];
    if (stall_threshold_min !== undefined) { sets.push('stall_threshold_min = ?'); vals.push(stall_threshold_min); }
    if (max_retries !== undefined) { sets.push('max_retries = ?'); vals.push(max_retries); }
    if (sort_rules !== undefined) { sets.push('sort_rules = ?'); vals.push(JSON.stringify(sort_rules)); }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    sets.push("last_active = datetime('now')");
    vals.push(agentId);
    if (agentTenantWhere) vals.push(tenantId);
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ? ${agentTenantWhere}`).run(...vals);

    const updated = db.prepare(`
      SELECT id as agent_id, name as agent_name, job_title,
             stall_threshold_min, max_retries, sort_rules
      FROM agents WHERE id = ? ${agentTenantWhere}
    `).get(agentId, ...agentTenantParams) as any;
    updated.sort_rules = (() => { try { return JSON.parse(updated.sort_rules || '[]'); } catch { return []; } })();

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK STATUSES — status flow management
// ═══════════════════════════════════════════════════════════════════════════════

// GET /statuses — all task statuses
router.get('/statuses', (_req: Request, res: Response) => {
  try {
    return res.json(listRoutingStatuses(getDb(), withRequestTenant(_req, normalizeWorkflowAliases(_req.query))));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// PUT /statuses/:name — update a status
router.put('/statuses/:name', (req: Request, res: Response) => {
  try {
    return res.json(updateRoutingStatus(getDb(), withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), name: req.params.name })));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// POST /statuses — add a new custom status
router.post('/statuses', (req: Request, res: Response) => {
  try {
    return res.status(201).json(createRoutingStatus(getDb(), withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body))));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// DELETE /statuses/:name — delete a custom status (with safety checks)
router.delete('/statuses/:name', (req: Request, res: Response) => {
  try {
    return res.json(deleteRoutingStatus(getDb(), withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), name: req.params.name })));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING TRANSITIONS — outcome-driven state machine
// ═══════════════════════════════════════════════════════════════════════════════

// GET /transitions — all routing transition rules
router.get('/transitions', (req: Request, res: Response) => {
  try {
    return res.json(listRoutingTransitions(getDb(), withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// GET /transitions/:id — fetch a single routing transition
router.get('/transitions/:id', (req: Request, res: Response) => {
  try {
    return res.json(getRoutingTransition(getDb(), withRequestTenant(req, { id: req.params.id, ...normalizeWorkflowAliases(req.query) })));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// POST /transitions — add a new routing transition
router.post('/transitions', (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body));
    return res.status(isDryRunInput(input) ? 200 : 201).json(dryRunConfigWrite('create', 'sprint_task_transitions', input, () => createRoutingTransition(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// PUT /transitions/:id — update a routing transition
router.put('/transitions/:id', (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(dryRunConfigWrite('update', 'sprint_task_transitions', input, () => updateRoutingTransition(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// DELETE /transitions/:id — remove a routing transition
router.delete('/transitions/:id', (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(dryRunConfigWrite('delete', 'sprint_task_transitions', input, () => deleteRoutingTransition(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK ROUTING RULES — deterministic task_type + status → job assignment
// ═══════════════════════════════════════════════════════════════════════════════

// GET /rules?sprint_id=X — all assignment rules for a sprint
const listAssignmentRulesHandler = (req: Request, res: Response) => {
  try {
    return res.json(listRoutingRulesForSprint(getDb(), withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.get(['/rules', '/assignment-rules'], listAssignmentRulesHandler);

// GET /rules/resolve — test assignment resolution for a given task_type + status + sprint
const resolveAssignmentRuleHandler = (req: Request, res: Response) => {
  try {
    return res.json(resolveRoutingRuleForSprint(getDb(), withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.get(['/rules/resolve', '/assignment-rules/resolve'], resolveAssignmentRuleHandler);

// GET /rules/:id — fetch a single sprint assignment rule
const getAssignmentRuleHandler = (req: Request, res: Response) => {
  try {
    return res.json(getRoutingRule(getDb(), withRequestTenant(req, { id: req.params.id, ...normalizeWorkflowAliases(req.query) })));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.get(['/rules/:id', '/assignment-rules/:id'], getAssignmentRuleHandler);

// POST /rules — create a new sprint assignment rule
const createAssignmentRuleHandler = (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body));
    return res.status(isDryRunInput(input) ? 200 : 201).json(dryRunConfigWrite('create', 'sprint_task_routing_rules', input, () => createRoutingRule(getDb(), input)));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.post(['/rules', '/assignment-rules'], createAssignmentRuleHandler);

// PUT /rules/:id — update a sprint assignment rule
const updateAssignmentRuleHandler = (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(dryRunConfigWrite('update', 'sprint_task_routing_rules', input, () => updateRoutingRule(getDb(), input)));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.put(['/rules/:id', '/assignment-rules/:id'], updateAssignmentRuleHandler);

// DELETE /rules/:id — remove a sprint assignment rule
const deleteAssignmentRuleHandler = (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(dryRunConfigWrite('delete', 'sprint_task_routing_rules', input, () => deleteRoutingRule(getDb(), input)));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.delete(['/rules/:id', '/assignment-rules/:id'], deleteAssignmentRuleHandler);

// ═══════════════════════════════════════════════════════════════════════════════
// WORKFLOW EVENT MAPPINGS — configurable workflow-event-to-workflow resolution
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/workflow-event-mappings', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    return res.json(listWorkflowEventMappings(db, { ...normalizeWorkflowAliases(req.query), tenant_id: tenantId }));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.get('/workflow-event-mappings/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    return res.json(getWorkflowEventMapping(db, { id: req.params.id, tenant_id: tenantId }));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.post('/workflow-event-mappings', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const input = { ...mergeWorkflowAliasInputs(req.query, req.body), tenant_id: tenantId };
    return res.status(isDryRunInput(input) ? 200 : 201).json(dryRunConfigWrite('create', 'external_event_mappings', input, () => createWorkflowEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.put('/workflow-event-mappings/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const input = { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id, tenant_id: tenantId };
    return res.json(dryRunConfigWrite('update', 'external_event_mappings', input, () => updateWorkflowEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.delete('/workflow-event-mappings/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const input = { ...req.query, ...(req.body ?? {}), id: req.params.id, tenant_id: tenantId };
    return res.json(dryRunConfigWrite('delete', 'external_event_mappings', input, () => deleteWorkflowEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// Compatibility aliases for integrations that still use the external-event routes.
router.get('/external-event-mappings', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    return res.json(listExternalEventMappings(db, { ...normalizeWorkflowAliases(req.query), tenant_id: tenantId }));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.get('/external-event-mappings/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    return res.json(getExternalEventMapping(db, { id: req.params.id, tenant_id: tenantId }));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.post('/external-event-mappings', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const input = { ...mergeWorkflowAliasInputs(req.query, req.body), tenant_id: tenantId };
    return res.status(isDryRunInput(input) ? 200 : 201).json(dryRunConfigWrite('create', 'external_event_mappings', input, () => createExternalEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.put('/external-event-mappings/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const input = { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id, tenant_id: tenantId };
    return res.json(dryRunConfigWrite('update', 'external_event_mappings', input, () => updateExternalEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.delete('/external-event-mappings/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const input = { ...req.query, ...(req.body ?? {}), id: req.params.id, tenant_id: tenantId };
    return res.json(dryRunConfigWrite('delete', 'external_event_mappings', input, () => deleteExternalEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// GET /task-types — return workflow-specific task types when scoped.
router.get('/task-types', (req: Request, res: Response) => {
  const db = getDb();
  const sprintType = req.query.sprint_type != null
    ? String(req.query.sprint_type)
    : resolveSprintTypeForSprintId(db, req.query.sprint_id ?? null);
  const taskTypes = getAllowedTaskTypesForSprintType(db, sprintType);
  if (taskTypes.length > 0) {
    return res.json({ sprint_type: sprintType, task_types: taskTypes, source: 'workflow_definition_config' });
  }
  return res.json({
    sprint_type: sprintType,
    task_types: VALID_TASK_TYPES,
    source: 'legacy_default_seed_fallback',
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSITION REQUIREMENTS — data-driven evidence gate checks (task #612)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /transition-requirement-fields — fields available for gate requirements.
// Field options come from the selected sprint type's task field schema.
router.get('/transition-requirement-fields', (req: Request, res: Response) => {
  try {
    return res.json(listTransitionRequirementFields(getDb(), withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// GET /transition-requirements — all requirements, optionally filtered
router.get('/transition-requirements', (req: Request, res: Response) => {
  try {
    return res.json(listTransitionRequirements(getDb(), withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
});

// POST /transition-requirements — create a new requirement
router.post('/transition-requirements', (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body));
    return res.status(isDryRunInput(input) ? 200 : 201).json(dryRunConfigWrite('create', 'sprint_task_transition_requirements', input, () => createTransitionRequirement(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// PUT /transition-requirements/:id — update a requirement
router.put('/transition-requirements/:id', (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(dryRunConfigWrite('update', 'sprint_task_transition_requirements', input, () => updateTransitionRequirement(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// DELETE /transition-requirements/:id — remove a requirement
router.delete('/transition-requirements/:id', (req: Request, res: Response) => {
  try {
    const input = withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(dryRunConfigWrite('delete', 'sprint_task_transition_requirements', input, () => deleteTransitionRequirement(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT CONTRACTS — editable sprint-type dispatch SOP templates
// ═══════════════════════════════════════════════════════════════════════════════

// __dirname at runtime = api/dist/routes → 3 levels up = repo root.
// Resolve lazily so tests and process managers can set env after import.
function normalizeSprintTypeKey(raw: unknown): string {
  return normalizeContractTemplateKey(typeof raw === 'string' ? raw : null);
}

function ensureSprintTypeExists(db: ReturnType<typeof getDb>, sprintTypeKey: string): void {
  const row = db.prepare(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`).get(sprintTypeKey) as { key: string } | undefined;
  if (!row) throw new Error(`Unknown sprint type "${sprintTypeKey}"`);
}

// GET /agent-contract — read the contract file for a sprint type
router.get('/agent-contract', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = normalizeSprintTypeKey(req.query.sprint_type ?? req.query.sprint_type_key);
    ensureSprintTypeExists(db, sprintTypeKey);
    const contract = readSprintTypeContractTemplate(sprintTypeKey);
    res.json({
      sprint_type: sprintTypeKey,
      content: contract.content,
      path: contract.path,
      inherited_from: contract.inheritedFrom,
      placeholders: getAvailableContractPlaceholders(),
      placeholder_definitions: CONTRACT_PLACEHOLDER_DEFINITIONS,
      format: 'plain_text_v1',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('Unknown sprint type') ? 404 : message.startsWith('No contract template found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

// PUT /agent-contract — write the contract file for a sprint type
router.put('/agent-contract', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = normalizeSprintTypeKey(req.body?.sprint_type ?? req.body?.sprint_type_key);
    ensureSprintTypeExists(db, sprintTypeKey);
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: '`content` (string) is required' });
    }
    const targetPath = writeSprintTypeContractTemplate(sprintTypeKey, content);
    res.json({ ok: true, sprint_type: sprintTypeKey, path: targetPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('Unknown sprint type') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
