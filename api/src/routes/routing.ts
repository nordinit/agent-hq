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
import { columnExists as sharedColumnExists } from "../db/introspection";
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
  getWorkflowGraph,
  traceHypothetical,
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

async function dryRunConfigWrite<T>(
  action: 'create' | 'update' | 'delete',
  table: string,
  input: Record<string, unknown>,
  run: () => T | Promise<T>,
): Promise<T | { dry_run: true; preview: { action: string; table: string; affected: T; input: Record<string, unknown> } }> {
  if (!isDryRunInput(input)) return await run();
  const db = getDb();
  await db.exec('SAVEPOINT dry_run_config_write');
  try {
    // The write is async now: it MUST settle before the savepoint is rolled back, or the
    // rows land after the rollback and the "preview" persists.
    const affected = await run();
    await db.exec('ROLLBACK TO dry_run_config_write');
    await db.exec('RELEASE dry_run_config_write');
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
      await db.exec('ROLLBACK TO dry_run_config_write');
      await db.exec('RELEASE dry_run_config_write');
    } catch {
      // Preserve the original validation error.
    }
    throw err;
  }
}

function mergeWorkflowAliasInputs(query: unknown, body?: unknown): Record<string, unknown> {
  return { ...normalizeWorkflowAliases(query), ...normalizeWorkflowAliases(body) };
}

async function withRequestTenant<T extends Record<string, unknown>>(req: Request, input: T): Promise<T & { tenant_id: number }> {
  const db = getDb();
  const tenantId = await resolveTenantIdFromRequest(db, req);
  return { ...input, tenant_id: tenantId };
}

async function routeTableHasColumn(table: string, column: string): Promise<boolean> {
  try {
    const db = getDb();
    return await sharedColumnExists(db, `${table}`, column);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING CONFIG — per-job settings
// ═══════════════════════════════════════════════════════════════════════════════

// GET /config — routing config for all agents
// Task #596: Reads from agents table directly (routing_config_legacy removed).
router.get('/config', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const tenantWhere = await routeTableHasColumn('agents', 'tenant_id') ? 'AND a.tenant_id = ?' : '';
    // Primary source: agents table (Phase 4 target)
    const configs = await db.all(`
      SELECT a.id as agent_id, a.name as agent_name, a.job_title,
             a.stall_threshold_min, a.max_retries, a.sort_rules
      FROM agents a
      WHERE a.enabled = 1
        ${tenantWhere}
      ORDER BY a.id
    `, ...(tenantWhere ? [tenantId] : []));

    const parsed = (configs as any[]).map(c => ({
      ...c,
      sort_rules: (() => { try { return JSON.parse(c.sort_rules || '[]'); } catch { return []; } })(),
    }));

    res.json({ configs: parsed });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/reconciler-config', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    res.json({
      needs_attention_eligible_statuses: await getNeedsAttentionEligibleStatuses(db),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/reconciler-config', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const statuses = await setNeedsAttentionEligibleStatuses(db, req.body?.needs_attention_eligible_statuses);
    res.json({ needs_attention_eligible_statuses: statuses });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /config/:job_id — single routing config (accepts job_id or agent_id)
// Task #594: Reads from agents table. job_id is resolved to agent_id for compat.
router.get('/config/:job_id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentTenantWhere = await routeTableHasColumn('agents', 'tenant_id') ? 'AND tenant_id = ?' : '';
    const agentTenantParams = agentTenantWhere ? [tenantId] : [];
    const paramId = Number(req.params.job_id);

    // Try agent_id directly
    const agent = await db.get(`
      SELECT id as agent_id, name as agent_name, job_title,
             stall_threshold_min, max_retries, sort_rules
      FROM agents WHERE id = ? ${agentTenantWhere}
    `, paramId, ...agentTenantParams) as any;

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
router.put('/config/:job_id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agentTenantWhere = await routeTableHasColumn('agents', 'tenant_id') ? 'AND tenant_id = ?' : '';
    const agentTenantParams = agentTenantWhere ? [tenantId] : [];
    const paramId = Number(req.params.job_id);
    const { stall_threshold_min, max_retries, sort_rules } = req.body;

    // Resolve to agent_id
    const agentDirect = await db.get(`SELECT id FROM agents WHERE id = ? ${agentTenantWhere}`, paramId, ...agentTenantParams) as { id: number } | undefined;
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
    await db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ? ${agentTenantWhere}`, ...vals);

    const updated = await db.get(`
      SELECT id as agent_id, name as agent_name, job_title,
             stall_threshold_min, max_retries, sort_rules
      FROM agents WHERE id = ? ${agentTenantWhere}
    `, agentId, ...agentTenantParams) as any;
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
router.get('/statuses', async (_req: Request, res: Response) => {
  try {
    return res.json(await listRoutingStatuses(getDb(), await withRequestTenant(_req, normalizeWorkflowAliases(_req.query))));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// PUT /statuses/:name — update a status
router.put('/statuses/:name', async (req: Request, res: Response) => {
  try {
    return res.json(await updateRoutingStatus(getDb(), await withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), name: req.params.name })));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// POST /statuses — add a new custom status
router.post('/statuses', async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await createRoutingStatus(getDb(), await withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body))));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// DELETE /statuses/:name — delete a custom status (with safety checks)
router.delete('/statuses/:name', async (req: Request, res: Response) => {
  try {
    return res.json(await deleteRoutingStatus(getDb(), await withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), name: req.params.name })));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING TRANSITIONS — outcome-driven state machine
// ═══════════════════════════════════════════════════════════════════════════════

// GET /transitions — all routing transition rules
router.get('/transitions', async (req: Request, res: Response) => {
  try {
    return res.json(await listRoutingTransitions(getDb(), await withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// GET /transitions/:id — fetch a single routing transition
router.get('/transitions/:id', async (req: Request, res: Response) => {
  try {
    return res.json(await getRoutingTransition(getDb(), await withRequestTenant(req, { id: req.params.id, ...normalizeWorkflowAliases(req.query) })));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// POST /transitions — add a new routing transition
router.post('/transitions', async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body));
    return res.status(isDryRunInput(input) ? 200 : 201).json(await dryRunConfigWrite('create', 'sprint_task_transitions', input, async () => await createRoutingTransition(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// PUT /transitions/:id — update a routing transition
router.put('/transitions/:id', async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(await dryRunConfigWrite('update', 'sprint_task_transitions', input, async () => await updateRoutingTransition(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// DELETE /transitions/:id — remove a routing transition
router.delete('/transitions/:id', async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(await dryRunConfigWrite('delete', 'sprint_task_transitions', input, async () => await deleteRoutingTransition(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING GRAPH — the workflow state machine as nodes + edges, derived server-side
// ═══════════════════════════════════════════════════════════════════════════════

// GET /graph?project_id=&workflow_type=&workflow_id=&task_type=
// Single representation shared by the canvas UI and Atlas, so neither has to
// re-derive the machine from the raw tables and reach a different answer.
router.get('/graph', async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, normalizeWorkflowAliases(req.query));
    return res.json(await getWorkflowGraph(getDb(), input));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// POST /trace — "if a <task_type> task in <from_status> reports <outcome>, then what?"
// Resolves against the same graph the canvas draws, so the two cannot disagree.
// GET is accepted too so a trace is linkable.
const traceHandler = async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body ?? {}));
    return res.json(await traceHypothetical(getDb(), input));
  } catch (err) {
    return sendRoutingError(res, err);
  }
};
router.post('/trace', traceHandler);
router.get('/trace', traceHandler);

// ═══════════════════════════════════════════════════════════════════════════════
// TASK ROUTING RULES — deterministic task_type + status → job assignment
// ═══════════════════════════════════════════════════════════════════════════════

// GET /rules?sprint_id=X — all assignment rules for a sprint
const listAssignmentRulesHandler = async (req: Request, res: Response) => {
  try {
    return res.json(await listRoutingRulesForSprint(getDb(), await withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.get(['/rules', '/assignment-rules'], listAssignmentRulesHandler);

// GET /rules/resolve — test assignment resolution for a given task_type + status + sprint
const resolveAssignmentRuleHandler = async (req: Request, res: Response) => {
  try {
    return res.json(await resolveRoutingRuleForSprint(getDb(), await withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.get(['/rules/resolve', '/assignment-rules/resolve'], resolveAssignmentRuleHandler);

// GET /rules/:id — fetch a single sprint assignment rule
const getAssignmentRuleHandler = async (req: Request, res: Response) => {
  try {
    return res.json(await getRoutingRule(getDb(), await withRequestTenant(req, { id: req.params.id, ...normalizeWorkflowAliases(req.query) })));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.get(['/rules/:id', '/assignment-rules/:id'], getAssignmentRuleHandler);

// POST /rules — create a new sprint assignment rule
const createAssignmentRuleHandler = async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body));
    return res.status(isDryRunInput(input) ? 200 : 201).json(await dryRunConfigWrite('create', 'sprint_task_routing_rules', input, async () => await createRoutingRule(getDb(), input)));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.post(['/rules', '/assignment-rules'], createAssignmentRuleHandler);

// PUT /rules/:id — update a sprint assignment rule
const updateAssignmentRuleHandler = async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(await dryRunConfigWrite('update', 'sprint_task_routing_rules', input, async () => await updateRoutingRule(getDb(), input)));
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? Number((err as { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
};
router.put(['/rules/:id', '/assignment-rules/:id'], updateAssignmentRuleHandler);

// DELETE /rules/:id — remove a sprint assignment rule
const deleteAssignmentRuleHandler = async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(await dryRunConfigWrite('delete', 'sprint_task_routing_rules', input, async () => await deleteRoutingRule(getDb(), input)));
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

router.get('/workflow-event-mappings', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    return res.json(await listWorkflowEventMappings(db, { ...normalizeWorkflowAliases(req.query), tenant_id: tenantId }));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.get('/workflow-event-mappings/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    return res.json(await getWorkflowEventMapping(db, { id: req.params.id, tenant_id: tenantId }));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.post('/workflow-event-mappings', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const input = { ...mergeWorkflowAliasInputs(req.query, req.body), tenant_id: tenantId };
    return res.status(isDryRunInput(input) ? 200 : 201).json(await dryRunConfigWrite('create', 'external_event_mappings', input, async () => await createWorkflowEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.put('/workflow-event-mappings/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const input = { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id, tenant_id: tenantId };
    return res.json(await dryRunConfigWrite('update', 'external_event_mappings', input, async () => await updateWorkflowEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.delete('/workflow-event-mappings/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const input = { ...req.query, ...(req.body ?? {}), id: req.params.id, tenant_id: tenantId };
    return res.json(await dryRunConfigWrite('delete', 'external_event_mappings', input, async () => await deleteWorkflowEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// Compatibility aliases for integrations that still use the external-event routes.
router.get('/external-event-mappings', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    return res.json(await listExternalEventMappings(db, { ...normalizeWorkflowAliases(req.query), tenant_id: tenantId }));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.get('/external-event-mappings/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    return res.json(await getExternalEventMapping(db, { id: req.params.id, tenant_id: tenantId }));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.post('/external-event-mappings', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const input = { ...mergeWorkflowAliasInputs(req.query, req.body), tenant_id: tenantId };
    return res.status(isDryRunInput(input) ? 200 : 201).json(await dryRunConfigWrite('create', 'external_event_mappings', input, () => createExternalEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.put('/external-event-mappings/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const input = { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id, tenant_id: tenantId };
    return res.json(await dryRunConfigWrite('update', 'external_event_mappings', input, () => updateExternalEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

router.delete('/external-event-mappings/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const input = { ...req.query, ...(req.body ?? {}), id: req.params.id, tenant_id: tenantId };
    return res.json(await dryRunConfigWrite('delete', 'external_event_mappings', input, () => deleteExternalEventMapping(db, input)));
  } catch (err) {
    return sendRoutingError(res, err);
  }
});

// GET /task-types — return workflow-specific task types when scoped.
router.get('/task-types', async (req: Request, res: Response) => {
  const db = getDb();
  const sprintType = req.query.sprint_type != null
    ? String(req.query.sprint_type)
    : await resolveSprintTypeForSprintId(db, req.query.sprint_id ?? null);
  const taskTypes = await getAllowedTaskTypesForSprintType(db, sprintType);
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
router.get('/transition-requirement-fields', async (req: Request, res: Response) => {
  try {
    return res.json(await listTransitionRequirementFields(getDb(), await withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// GET /transition-requirements — all requirements, optionally filtered
router.get('/transition-requirements', async (req: Request, res: Response) => {
  try {
    return res.json(await listTransitionRequirements(getDb(), await withRequestTenant(req, normalizeWorkflowAliases(req.query))));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ error: message });
  }
});

// POST /transition-requirements — create a new requirement
router.post('/transition-requirements', async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, mergeWorkflowAliasInputs(req.query, req.body));
    return res.status(isDryRunInput(input) ? 200 : 201).json(await dryRunConfigWrite('create', 'sprint_task_transition_requirements', input, async () => await createTransitionRequirement(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// PUT /transition-requirements/:id — update a requirement
router.put('/transition-requirements/:id', async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(await dryRunConfigWrite('update', 'sprint_task_transition_requirements', input, async () => await updateTransitionRequirement(getDb(), input)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: String((err as Error).message ?? err) });
  }
});

// DELETE /transition-requirements/:id — remove a requirement
router.delete('/transition-requirements/:id', async (req: Request, res: Response) => {
  try {
    const input = await withRequestTenant(req, { ...mergeWorkflowAliasInputs(req.query, req.body), id: req.params.id });
    return res.json(await dryRunConfigWrite('delete', 'sprint_task_transition_requirements', input, async () => await deleteTransitionRequirement(getDb(), input)));
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

async function ensureSprintTypeExists(db: ReturnType<typeof getDb>, sprintTypeKey: string): Promise<void> {
  const row = await db.get(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`, sprintTypeKey) as { key: string } | undefined;
  if (!row) throw new Error(`Unknown sprint type "${sprintTypeKey}"`);
}

// GET /agent-contract — read the contract file for a sprint type
router.get('/agent-contract', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = normalizeSprintTypeKey(req.query.sprint_type ?? req.query.sprint_type_key);
    await ensureSprintTypeExists(db, sprintTypeKey);
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
router.put('/agent-contract', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const sprintTypeKey = normalizeSprintTypeKey(req.body?.sprint_type ?? req.body?.sprint_type_key);
    await ensureSprintTypeExists(db, sprintTypeKey);
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
