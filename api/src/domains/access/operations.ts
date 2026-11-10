import manifest from './operations.generated.json';
export type OperationEffect = 'data_read' | 'data_write' | 'registration' | 'publication' | 'assignment' | 'execution' | 'host_configuration' | 'host_execution' | 'permission_change';
export interface OperationPolicy {
    requirements: string[];
    effect: OperationEffect;
    projection?: 'project' | 'registry';
}
const read = (requirements: string[], projection?: OperationPolicy['projection']): OperationPolicy => ({ requirements, effect: 'data_read', projection });
export function canonicalPolicyPath(p: string): string {
    try {
        p = decodeURIComponent(p);
    }
    catch {
        return '<invalid-path>';
    }
    p = p.replace(/\/+$/, '') || '/';
    return p.replace(/^\/(?:assignment-rules|routing-rules)(?=\/|$)/, '/routing/assignment-rules')
        .replace(/^\/(?:model-routing|story-point-routing|model-routing-rules)(?=\/|$)/, '/model-routing-rules')
        .replace(/^\/routing\/(?:model-routing|story-point-routing|model-routing-rules|model-routes)(?=\/|$)/, '/model-routing-rules')
        .replace(/^\/workflow-definitions(?=\/|$)/, '/workflows');
}
/** Additional delegation gates never replace existing project/lifecycle scope checks. */
export function delegatedExecution(method: string, p: string, body: Record<string, unknown>): boolean {
    p = canonicalPolicyPath(p);
    if (method === 'GET' || method === 'DELETE')
        return false;
    if (p === '/tasks' && method === 'POST')
        return true;
    if (['PUT', 'PATCH'].includes(method) && /^\/tasks\/[^/]+$/.test(p) && ['title', 'description', 'instructions', 'agent_id', 'workflow_id', 'status', 'scheduled_for'].some(k => k in body))
        return true;
    if (['PUT', 'PATCH'].includes(method) && /^\/(?:projects|workflows)\/[^/]+$/.test(p) && ['context_md', 'goal', 'instructions'].some(k => k in body))
        return true;
    if (['PUT','PATCH'].includes(method) && /^\/(?:agents|teams)\/[^/]+$/.test(p) && (('enabled' in body&&Boolean(body.enabled))||'status' in body))
        return true;
    if ((method === 'POST' && p === '/recurring-task-series') || (['PUT', 'PATCH'].includes(method) && /^\/recurring-task-series\/[^/]+$/.test(p)) || (method === 'POST' && /^\/recurring-task-series\/[^/]+\/(?:enable|run-now)$/.test(p)))
        return true;
    if (/^\/teams\/[^/]+\/(?:members|routing-rules)|^\/workflows\/[^/]+\/team|^\/agents\/[^/]+\/dispatch-contract/.test(p))
        return true;
    if (/^\/(?:routing\/(?:rules|assignment-rules|transitions)|workflow-events)/.test(p))
        return true;
    if (/^\/(?:model-routing-rules|workflows\/types|workflow-types|task-definitions|task-field-definitions|task-field-schemas)/.test(p))
        return true;
    return false;
}
/** Curated board reads, never a blanket GET permission. Handlers still assert tenant ownership. */
export function isProjectRead(method: string, p: string): boolean {
    p = canonicalPolicyPath(p);
    if (method !== 'GET')
        return false;
    return [
        /^\/projects(?:\/\d+(?:\/(?:context|metrics|audit|jobs))?)?$/,
        /^\/workflows(?:\/\d+(?:\/(?:metrics|jobs))?)?$/,
        /^\/workflows\/(?:workflow-metadata|config|types(?:\/.*)?)$/,
        /^\/tasks(?:\/(?:search|completed-recent|field-schema\/resolve|\d+(?:\/(?:context|notes|history|instances|relationships|relationship-types|active-owner))?))?$/,
        /^\/agents(?:\/\d+)?$/,
        /^\/instances(?:\/\d+\/(?:context|activity))?$/,
        /^\/recurring-task-series(?:\/\d+(?:\/history)?)?$/,
        /^\/routing\/(?:assignment-rules|rules|transitions|statuses|task-types|workflow-event-mappings|transition-requirements)(?:\/[^/]+)?$/,
        /^\/telemetry\/v2\/(?:catalog|coverage|routing-signals|metrics|profiles|reports|dashboards|bindings|snapshots|queries)(?:\/[^/]+(?:\/contributors)?)?$/,
    ].some(r => r.test(p));
}
/** Sensitive operations are evaluated BEFORE the legacy business-administration fallback. */
export function sensitiveOperation(method: string, p: string, body: Record<string, unknown> = {}): OperationPolicy | null {
    p = canonicalPolicyPath(p);
    if (p.startsWith('/execution')) {
        if (p === '/execution/readiness')
            return read(['permissions.manage']);
        if (method === 'GET' && (p === '/execution/presets' || p === '/execution/operations'))
            return read(['discovery.read_catalog']);
        if (method === 'GET' && p === '/execution/agent-tools')
            return read(['tools.execute']);
        if (method === 'GET' && /^\/execution\/revisions\/[^/]+$/.test(p))
            return read(['tools.publish']);
        if (method === 'GET')
            return read(['tools.read'], 'registry');
        if (p.endsWith('/publish') || p.endsWith('/revoke'))
            return { requirements: ['tools.publish'], effect: 'publication' };
        if (/^\/execution\/bindings(?:\/[^/]+)?$/.test(p))
            return { requirements: ['tools.assign'], effect: 'assignment' };
        if (p === '/execution/authorize')
            return { requirements: ['host.execute', 'tools.execute'], effect: 'host_execution' };
        if (p === '/execution/invoke' || /^\/execution\/agents\/[^/]+\/invoke$/.test(p))
            return { requirements: ['tools.execute', 'host.execute'], effect: 'execution' };
        return { requirements: ['tools.register'], effect: 'registration' };
    }
    if (/^\/(?:tools|mcp-servers)(?:\/[^/]+)?$/.test(p))
        return method === 'GET' ? read(['tools.read'], 'registry') : { requirements: method === 'DELETE' || ('enabled' in body && method !== 'POST') ? ['tools.register', 'tools.publish'] : ['tools.register'], effect: 'registration' };
    if (/^\/tools\/[^/]+\/test$/.test(p))
        return { requirements: ['tools.execute', 'host.execute'], effect: 'execution' };
    if (/^\/(?:agents|teams)\/[^/]+\/(?:tools|mcp-servers)(?:\/[^/]+)?$/.test(p))
        return method === 'GET' ? read(['tools.read'], 'registry') : { requirements: ['tools.assign'], effect: 'assignment' };
    if (/\/tools\/materialized$|^\/tools\/materialized\//.test(p))
        return read(['tools.execute', 'host.execute']);
    if (/^\/agents\/[^/]+\/mcp-permissions\/preview$/.test(p))
        return read(['mcp_capability_policies.read']);
    if (/^\/agents\/[^/]+\/mcp-tool-allowlists/.test(p))
        return method === 'GET' ? read(['tools.read']) : { requirements: ['tools.assign'], effect: 'assignment' };
    if (/^\/agents\/[^/]+\/mcp-permissions/.test(p))
        return method === 'GET' ? read(['mcp_capability_policies.read']) : { requirements: ['permissions.manage'], effect: 'permission_change' };
    if (/^\/(?:teams|model-routing-rules)(?:\/.*)?$/.test(p) && method === 'GET')
        return read(['tools.read'], 'registry');
    if (/^\/agents\/[^/]+\/(?:teams|effective-capabilities)$/.test(p) && method === 'GET')
        return read(['tools.read'], 'registry');
    if (p.startsWith('/artifacts/'))
        return method === 'GET' ? read(['host.files.read']) : { requirements: ['host.configure', 'tools.publish', 'host.execute'], effect: 'host_configuration' };
    if (/^\/instances\/[^/]+\/context$/.test(p) && method === 'GET')
        return read(['host.files.read']);
    if (/^\/skills\/[^/]+\/file\//.test(p) && method === 'GET')
        return read(['host.files.read']);
    if (/^\/skills(?:\/.*)?$/.test(p))
        return method === 'GET' ? read(['tools.read'], 'registry') : { requirements: ['host.configure', 'tools.publish'], effect: 'host_configuration' };
    if (/^\/agents\/[^/]+\/(?:claude-md|docs)$/.test(p) && method === 'GET')
        return read(['host.files.read']);
    if (/^\/agents\/[^/]+\/(?:skills|claude-md)(?:\/.*)?$/.test(p))
        return method === 'GET' ? read(['tools.read'], 'registry') : { requirements: ['host.configure', 'tools.publish', 'host.execute'], effect: 'host_configuration' };
    if (/\/provision(?:-full)?$|\/mcp\/sync$|\/mcp-recovery\/retry$/.test(p))
        return { requirements: ['host.configure', 'host.execute'], effect: 'host_execution' };
    if (/^\/runtime-drivers\/diagnose$|^\/setup\/runtime\/(?:test|detect|status)$|^\/settings\/gateway\/(?:restart|pair|status)$/.test(p))
        return { requirements: ['host.execute'], effect: 'host_execution' };
    if (/^\/agents\/local-mlx\/status$/.test(p))
        return read(['host.execute']);
    if (/^\/(?:providers|provider-connections)\/.*\/(?:validate|discover|initiate|exchange|setup-token)$/.test(p) || p === '/provider-connections/discover')
        return { requirements: ['host.configure', 'host.execute'], effect: 'host_execution' };
    if (/^\/(?:tenants|companies)(?:\/|$)/.test(p))
        return { requirements: ['admin.cross_tenant'], effect: method === 'GET' ? 'data_read' : 'permission_change' };
    if (/^\/chat\/.*(?:runtime-transcript|messages)$|^\/instances\/[^/]+\/messages$|^\/sessions(?:\/.*)?$|^\/logs(?:\/.*)?$/.test(p) && method === 'GET')
        return read(['host.files.read']);
    if (p === '/chat/config')
        return read(['host.configure']);
    if (/^\/(?:settings|setup\/runtime\/config|providers|provider-connections|github-identities)/.test(p))
        return { requirements: p.startsWith('/settings/')&&method!=='GET'?['host.configure','tools.publish','host.execute']:['host.configure'], effect: 'host_configuration' };
    if (/^\/dispatch\/(?:trigger|reconcile)$|^\/chat\/.*\/(?:send|rotate)$|^\/recurring-task-series\/[^/]+\/run-now$/.test(p))
        return { requirements: ['runs.dispatch', 'host.execute'], effect: 'host_execution' };
    if (p === '/projects/import' || p === '/setup/starter-plan/apply')
        return { requirements: ['host.configure', 'tools.assign'], effect: 'host_configuration' };
    if ((p === '/agents' && method === 'POST') || (/^\/agents\/[^/]+$/.test(p) && method === 'DELETE'))
        return { requirements: ['host.configure', 'host.execute'], effect: 'host_configuration' };
    if (/^\/(?:agents|teams)(?:\/[^/]+)?$/.test(p) && method !== 'GET') {
        const protectedFields = ['workspace_path', 'runtime_type', 'runtime_config', 'hooks_url', 'hooks_auth_header', 'os_user', 'github_identity_id', 'provider_connection_id', 'provision_openclaw', 'job_instructions', 'context', 'instructions', 'charter', 'skill_names'];
        const safeFields = ['name', 'slug', 'description', 'role', 'model', 'project_id', 'enabled', 'status', 'sort_order', 'goal', 'is_default', 'max_concurrent'];
        if (protectedFields.some(k => Object.prototype.hasOwnProperty.call(body, k)) || Object.keys(body).some(k => !safeFields.includes(k)))
            return { requirements: ['host.configure'], effect: 'host_configuration' };
    }
    if (p !== '/workflows/types' && /^\/workflows(?:\/[^/]+)?$/.test(p) && method !== 'GET') {
        const safe = ['name', 'goal', 'workflow_type', 'status', 'length_kind', 'length_value', 'started_at', 'ended_at', 'project_id', 'dry_run', 'note'];
        if (Object.keys(body).some(k => !safe.includes(k)))
            return { requirements: ['host.configure'], effect: 'host_configuration' };
    }
    return null;
}
export function safeResponse(value: unknown, kind: 'project' | 'registry'): unknown {
    const blocked = /^(?:.*(?:token|password|secret|credential|api[_-]?key|authorization).*|headers|env|runtime_config|runtime|prompt|transcript|messages|dispatch_context|context_bundle|job_instructions|instructions|hooks_auth_header|hooks_url|workspace_path|implementation_body|execution_payload|config|overrides|.*_json)$/i;
    const registry = /^(?:command|args|cwd|input_schema|content|body|fs_path|files|source|section|charter)$/;
    if (Array.isArray(value))
        return value.map(x => safeResponse(x, kind));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).filter(([k]) => !blocked.test(k) && !(kind === 'registry' && registry.test(k))).map(([k, v]) => [k, safeResponse(v, kind)]));
    if (typeof value === 'string') {
        if (/^[\[{]/.test(value.trim())) {
            try {
                return JSON.stringify(safeResponse(JSON.parse(value), kind));
            }
            catch { /* free text */ }
        }
        return value.replace(/(?:Bearer\s+|(?:sk|ghp|github_pat)[-_])[A-Za-z0-9_\-.]{12,}/g, '[redacted]').replace(/(postgres(?:ql)?:\/\/)[^\s]+/g, '$1[redacted]');
    }
    return value;
}
export function operationId(method:string,path:string):string {
  const scope=path.startsWith('/api/v1/')?'v1':'transport';
  const segments=path.replace(/^\/api\/v1/,'').split('/').filter(Boolean).map(segment=>segment.startsWith(':')?'item':segment.replace(/[^a-zA-Z0-9_-]/g,'_'));
  return [method.toLowerCase(),scope,...segments].join('.');
}

export function policyExamplePath(p: string): string { return p.replace(/:[^/]+/g, '1'); }
export function knownOperation(method: string, p: string): boolean {
    return manifest.operations.some(o => (o.method === method || o.method === 'ALL' || (method === 'HEAD' && o.method === 'GET')) && new RegExp('^' + o.path.replace(/^\/api\/v1/, '').split('/').map(segment => segment.startsWith(':') ? '[^/]+' : segment === '*' ? '.*' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '/?$').test(p));
}
export function navigationGroup(owner: string): string {
    if (['projects', 'project_files', 'workflow_files', 'tasks'].includes(owner))
        return 'Projects / Work';
    if (['instances', 'sessions', 'lifecycle'].includes(owner))
        return 'Runs / Lifecycle';
    if (['dispatch', 'recurring-task-series', 'recurring_task_series', 'workflow-events', 'external_task_events'].includes(owner))
        return 'Automation';
    if (['agents', 'teams'].includes(owner))
        return 'Agents / Teams';
    if (['tools', 'mcp-servers', 'mcp_servers', 'skills', 'execution'].includes(owner))
        return 'Capability Registry';
    if (['telemetry', 'logs', 'stats'].includes(owner))
        return 'Observability';
    if (['settings', 'setup', 'runtime-drivers', 'providers', 'provider-connections', 'github-identities', 'artifacts'].includes(owner))
        return 'Host / Providers';
    if (['mcp', 'tenants', 'companies', 'advanced'].includes(owner))
        return 'Identity / Access';
    return 'Workflow Policy / Routing';
}
export function operationCatalog() {
    return manifest.operations.map(operation => {
        const path = operation.path.replace(/^\/api\/v1/, '');
        const example = policyExamplePath(path);
        const policy = sensitiveOperation(operation.method, example);
        const projectRead = isProjectRead(operation.method, example);
        const owner = path.replace(/^\//, '').split('/')[0];
        const fields: Record<string, string[]> = {};
        if (/^\/(agents|teams)(?:\/[^/]+)?$/.test(example))
            fields.protected_runtime_or_instruction_fields = ['host.configure'];
        if (/^\/workflows(?:\/[^/]+)?$/.test(example))
            fields.repository_or_setup_fields = ['host.configure'];
        if (/^\/(?:tasks|routing|assignment-rules|routing-rules|recurring-task-series|teams)/.test(example))
            fields.executable_work_and_routing = ['runs.dispatch', 'host.execute'];
        const readOnly = operation.method === 'GET' && (!policy || policy.effect === 'data_read');
        return {
            ...operation, operation_id: operationId(operation.method, operation.path),
            canonical_operation_id: operationId(operation.method, operation.canonical_path),
            owner, navigation_group: navigationGroup(owner),
            effects: [policy?.effect ?? (operation.method === 'GET' ? 'data_read' : 'data_write')],
            requirements: policy?.requirements ?? [], policy_mode: policy ? 'explicit_boundary' : 'domain_scope',
            project_read: projectRead, response_projection: policy?.projection ?? (projectRead ? 'project' : null),
            field_dependent_requirements: fields,
            scope_resolver: policy || projectRead ? 'tenant_owned_resource' : 'legacy_domain_scope',
            retry_policy: readOnly ? 'safe_read' : 'do_not_retry_automatically',
            audit_policy: policy && policy.effect !== 'data_read' ? 'execution_audit' : 'domain_audit',
            exposure: operation.retired ? 'retired' : operation.compatibility ? 'compatibility' : operation.public ? 'public' : 'internal',
        };
    });
}
