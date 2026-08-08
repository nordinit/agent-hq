import { createHash } from 'crypto';

export const RUNTIME_BOUNDARY_VERSION = 1 as const;
export const RUNTIME_CHECKPOINT_VERSION = 1 as const;
export const RUNTIME_LAUNCH_SPEC_VERSION = 1 as const;
export const RUNTIME_HANDLE_VERSION = 1 as const;

export const RUNTIME_EXECUTION_STATES = [
  'preparing',
  'starting',
  'running',
  'interrupting',
  'succeeded',
  'failed',
  'cancelled',
  'lost',
] as const;
export type RuntimeExecutionState = (typeof RUNTIME_EXECUTION_STATES)[number];

export const RUNTIME_CHECKPOINT_KINDS = [
  'prepared',
  'launched',
  'session',
  'progress',
  'interrupt_requested',
  'interrupted',
  'terminal',
  'reconciled',
] as const;
export type RuntimeCheckpointKind = (typeof RUNTIME_CHECKPOINT_KINDS)[number];

export type RuntimeExecutionTargetKind = 'local-process' | 'ssh' | 'sandbox' | 'managed';
export type RuntimeExecutionTrustLevel = 'untrusted' | 'workspace' | 'trusted';
export type RuntimeExecutionCapability =
  | 'inspect'
  | 'signals'
  | 'resume'
  | 'live-redirect'
  | 'workspace-write'
  | 'network'
  | (string & {});

export interface RuntimeBoundaryIdentityV1 {
  tenantId: number;
  projectId: number | null;
  workflowId: number | null;
  taskId: number | null;
  instanceId: number;
  durableRunId: string;
  agentId: number;
  agentSlug: string;
}

export interface RuntimeBoundaryRuntimeV1 {
  type: string;
  driverVersion: string;
  /** Canonical local CLI identity; null for non-local or remotely managed runtimes. */
  executableFingerprint: string | null;
  configRevision: string | null;
  model: string | null;
  reasoning: string | null;
  fastMode: boolean | null;
  timeoutSeconds: number;
  tokenBudget: number | null;
  turnLimit: number | null;
}

export interface RuntimeBoundaryWorkspaceV1 {
  workspaceRoot: string | null;
  activeRepoRoot: string;
  repoAccessMode: 'worktree' | 'clone' | 'workspace' | 'remote' | null;
  repoSource: string | null;
  branch: string | null;
  commit: string | null;
  /** Hash of the target/cwd/repository facts used to reject unsafe resume. */
  fingerprint: string;
}

export interface RuntimeExecutionTargetV1 {
  id: string;
  kind: RuntimeExecutionTargetKind;
  trustLevel: RuntimeExecutionTrustLevel;
  capabilities: RuntimeExecutionCapability[];
}

export interface RuntimeMcpAssignmentV1 {
  name: string;
  configFingerprint: string;
  requiredToolNames: string[];
}

export interface RuntimeSkillAssignmentV1 {
  name: string;
  revision: string | null;
}

/**
 * A registry tool (`tools` + `agent_tool_assignments`) granted to this run.
 *
 * Recorded by slug plus a `definitionFingerprint` over the tool's executable
 * definition — implementation, input schema and permissions. The slug alone
 * would let a tool's body be rewritten between dispatch and resume without
 * changing the boundary hash, which is exactly the unrecorded-capability drift
 * this contract exists to prevent. The body itself is deliberately not stored:
 * it can contain operator secrets, and the boundary is a durable audit record.
 */
export interface RuntimeRegistryToolAssignmentV1 {
  slug: string;
  permissions: string;
  definitionFingerprint: string;
}

export interface RuntimeCredentialReferenceV1 {
  kind: 'provider-connection' | 'environment' | 'operator-profile' | 'managed-identity';
  reference: string;
}

export interface RuntimeCheckpointReferenceV1 {
  executionId: number;
  checkpointId: number;
  sequence: number;
  boundaryFingerprint: string;
}

/**
 * Complete, versioned input to a runtime driver.
 *
 * Credential values and resolved environment values are intentionally absent.
 * Persist only references and names so the boundary is safe to audit.
 */
export interface RuntimeBoundaryV1 {
  version: typeof RUNTIME_BOUNDARY_VERSION;
  identity: RuntimeBoundaryIdentityV1;
  runtime: RuntimeBoundaryRuntimeV1;
  workspace: RuntimeBoundaryWorkspaceV1;
  prompt: {
    bundleFingerprint: string;
  };
  executionTarget: RuntimeExecutionTargetV1;
  tools: {
    builtIn: string[];
    mcpServers: RuntimeMcpAssignmentV1[];
    requiredLifecycleTools: string[];
    skills: RuntimeSkillAssignmentV1[];
    registryTools: RuntimeRegistryToolAssignmentV1[];
  };
  auth: {
    provider: string | null;
    providerConnectionId: number | null;
    credentialRefs: RuntimeCredentialReferenceV1[];
  };
  evidence: {
    required: boolean;
    requirements: string[];
  };
  callback: {
    identity: string;
  };
  priorCheckpoint: RuntimeCheckpointReferenceV1 | null;
  observability: {
    traceId: string;
    correlationId: string;
    requestedBy: string | null;
  };
}

/** A launch record cannot accidentally persist environment/credential values. */
export interface SanitizedRuntimeLaunchSpecV1 {
  version: typeof RUNTIME_LAUNCH_SPEC_VERSION;
  command: string;
  /** Non-secret host file identity captured when the command was resolved. */
  executableFingerprint?: string;
  args: string[];
  cwd: string | null;
  envKeys: string[];
}

export interface LocalProcessExecutionHandleV1 {
  version: typeof RUNTIME_HANDLE_VERSION;
  kind: 'local-process';
  pid: number;
  processGroupId: number | null;
  /** Birth fingerprint used to reject a PID that was reused after restart. */
  processIdentity: string | null;
  hostname: string;
  startedAt: string;
}

export interface RemoteExecutionHandleV1 {
  version: typeof RUNTIME_HANDLE_VERSION;
  kind: 'remote';
  externalRunId: string;
  targetId: string;
  startedAt: string;
}

export type RuntimeExecutionHandleV1 = LocalProcessExecutionHandleV1 | RemoteExecutionHandleV1;

export interface RuntimeExecutionV1 {
  id: number;
  tenantId: number;
  instanceId: number;
  boundary: RuntimeBoundaryV1;
  boundaryFingerprint: string;
  runtimeType: string;
  driver: string;
  backend: string;
  executionTargetId: string;
  state: RuntimeExecutionState;
  launchSpec: SanitizedRuntimeLaunchSpecV1 | null;
  handle: RuntimeExecutionHandleV1 | null;
  sessionId: string | null;
  capabilities: RuntimeExecutionCapability[];
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  terminalReason: string | null;
  terminalError: string | null;
  terminalMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeCheckpointV1 {
  version: typeof RUNTIME_CHECKPOINT_VERSION;
  id: number;
  tenantId: number;
  executionId: number;
  sequence: number;
  kind: RuntimeCheckpointKind;
  state: RuntimeExecutionState;
  sessionId: string | null;
  boundaryFingerprint: string;
  transcriptCursor: Record<string, unknown> | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeContractValidationIssue {
  path: string;
  message: string;
}

export type RuntimeContractValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: RuntimeContractValidationIssue[] };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, path: string, issues: RuntimeContractValidationIssue[]): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return null;
  }
  return value as UnknownRecord;
}

function nonEmptyString(value: unknown, path: string, issues: RuntimeContractValidationIssue[]): void {
  if (typeof value !== 'string' || !value.trim()) issues.push({ path, message: 'must be a non-empty string' });
}

function nullableString(value: unknown, path: string, issues: RuntimeContractValidationIssue[]): void {
  if (value !== null && typeof value !== 'string') issues.push({ path, message: 'must be a string or null' });
}

function positiveInteger(value: unknown, path: string, issues: RuntimeContractValidationIssue[]): void {
  if (!Number.isInteger(value) || Number(value) <= 0) issues.push({ path, message: 'must be a positive integer' });
}

function nullablePositiveInteger(value: unknown, path: string, issues: RuntimeContractValidationIssue[]): void {
  if (value !== null) positiveInteger(value, path, issues);
}

function stringSet(value: unknown, path: string, issues: RuntimeContractValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    nonEmptyString(item, `${path}[${index}]`, issues);
    if (typeof item === 'string' && item.trim()) {
      if (seen.has(item)) issues.push({ path: `${path}[${index}]`, message: 'must not contain duplicates' });
      seen.add(item);
    }
  });
}

function validateIdentity(value: unknown, issues: RuntimeContractValidationIssue[]): void {
  const item = record(value, 'identity', issues);
  if (!item) return;
  positiveInteger(item.tenantId, 'identity.tenantId', issues);
  nullablePositiveInteger(item.projectId, 'identity.projectId', issues);
  nullablePositiveInteger(item.workflowId, 'identity.workflowId', issues);
  nullablePositiveInteger(item.taskId, 'identity.taskId', issues);
  positiveInteger(item.instanceId, 'identity.instanceId', issues);
  nonEmptyString(item.durableRunId, 'identity.durableRunId', issues);
  positiveInteger(item.agentId, 'identity.agentId', issues);
  nonEmptyString(item.agentSlug, 'identity.agentSlug', issues);
}

function validateRuntime(value: unknown, issues: RuntimeContractValidationIssue[]): void {
  const item = record(value, 'runtime', issues);
  if (!item) return;
  nonEmptyString(item.type, 'runtime.type', issues);
  nonEmptyString(item.driverVersion, 'runtime.driverVersion', issues);
  nullableString(item.executableFingerprint, 'runtime.executableFingerprint', issues);
  nullableString(item.configRevision, 'runtime.configRevision', issues);
  nullableString(item.model, 'runtime.model', issues);
  nullableString(item.reasoning, 'runtime.reasoning', issues);
  if (item.fastMode !== null && typeof item.fastMode !== 'boolean') {
    issues.push({ path: 'runtime.fastMode', message: 'must be a boolean or null' });
  }
  if (typeof item.timeoutSeconds !== 'number' || !Number.isFinite(item.timeoutSeconds) || item.timeoutSeconds < 0) {
    issues.push({ path: 'runtime.timeoutSeconds', message: 'must be a finite non-negative number' });
  }
  nullablePositiveInteger(item.tokenBudget, 'runtime.tokenBudget', issues);
  nullablePositiveInteger(item.turnLimit, 'runtime.turnLimit', issues);
}

function validateWorkspace(value: unknown, issues: RuntimeContractValidationIssue[]): void {
  const item = record(value, 'workspace', issues);
  if (!item) return;
  nullableString(item.workspaceRoot, 'workspace.workspaceRoot', issues);
  nonEmptyString(item.activeRepoRoot, 'workspace.activeRepoRoot', issues);
  const modes = ['worktree', 'clone', 'workspace', 'remote', null];
  if (!modes.includes(item.repoAccessMode as never)) {
    issues.push({ path: 'workspace.repoAccessMode', message: 'has an unsupported value' });
  }
  nullableString(item.repoSource, 'workspace.repoSource', issues);
  nullableString(item.branch, 'workspace.branch', issues);
  nullableString(item.commit, 'workspace.commit', issues);
  nonEmptyString(item.fingerprint, 'workspace.fingerprint', issues);
}

function validateExecutionTarget(value: unknown, issues: RuntimeContractValidationIssue[]): void {
  const item = record(value, 'executionTarget', issues);
  if (!item) return;
  nonEmptyString(item.id, 'executionTarget.id', issues);
  if (!['local-process', 'ssh', 'sandbox', 'managed'].includes(String(item.kind))) {
    issues.push({ path: 'executionTarget.kind', message: 'has an unsupported value' });
  }
  if (!['untrusted', 'workspace', 'trusted'].includes(String(item.trustLevel))) {
    issues.push({ path: 'executionTarget.trustLevel', message: 'has an unsupported value' });
  }
  stringSet(item.capabilities, 'executionTarget.capabilities', issues);
}

function validateTools(value: unknown, issues: RuntimeContractValidationIssue[]): void {
  const item = record(value, 'tools', issues);
  if (!item) return;
  stringSet(item.builtIn, 'tools.builtIn', issues);
  stringSet(item.requiredLifecycleTools, 'tools.requiredLifecycleTools', issues);

  if (!Array.isArray(item.mcpServers)) {
    issues.push({ path: 'tools.mcpServers', message: 'must be an array' });
  } else {
    item.mcpServers.forEach((server, index) => {
      const serverRecord = record(server, `tools.mcpServers[${index}]`, issues);
      if (!serverRecord) return;
      nonEmptyString(serverRecord.name, `tools.mcpServers[${index}].name`, issues);
      nonEmptyString(serverRecord.configFingerprint, `tools.mcpServers[${index}].configFingerprint`, issues);
      stringSet(serverRecord.requiredToolNames, `tools.mcpServers[${index}].requiredToolNames`, issues);
    });
  }

  if (!Array.isArray(item.skills)) {
    issues.push({ path: 'tools.skills', message: 'must be an array' });
  } else {
    item.skills.forEach((skill, index) => {
      const skillRecord = record(skill, `tools.skills[${index}]`, issues);
      if (!skillRecord) return;
      nonEmptyString(skillRecord.name, `tools.skills[${index}].name`, issues);
      nullableString(skillRecord.revision, `tools.skills[${index}].revision`, issues);
    });
  }

  if (!Array.isArray(item.registryTools)) {
    issues.push({ path: 'tools.registryTools', message: 'must be an array' });
  } else {
    item.registryTools.forEach((tool, index) => {
      const toolRecord = record(tool, `tools.registryTools[${index}]`, issues);
      if (!toolRecord) return;
      nonEmptyString(toolRecord.slug, `tools.registryTools[${index}].slug`, issues);
      nonEmptyString(toolRecord.permissions, `tools.registryTools[${index}].permissions`, issues);
      nonEmptyString(
        toolRecord.definitionFingerprint,
        `tools.registryTools[${index}].definitionFingerprint`,
        issues,
      );
    });
  }
}

function validateAuth(value: unknown, issues: RuntimeContractValidationIssue[]): void {
  const item = record(value, 'auth', issues);
  if (!item) return;
  nullableString(item.provider, 'auth.provider', issues);
  nullablePositiveInteger(item.providerConnectionId, 'auth.providerConnectionId', issues);
  if (!Array.isArray(item.credentialRefs)) {
    issues.push({ path: 'auth.credentialRefs', message: 'must be an array' });
    return;
  }
  item.credentialRefs.forEach((credential, index) => {
    const credentialRecord = record(credential, `auth.credentialRefs[${index}]`, issues);
    if (!credentialRecord) return;
    if (!['provider-connection', 'environment', 'operator-profile', 'managed-identity'].includes(String(credentialRecord.kind))) {
      issues.push({ path: `auth.credentialRefs[${index}].kind`, message: 'has an unsupported value' });
    }
    nonEmptyString(credentialRecord.reference, `auth.credentialRefs[${index}].reference`, issues);
  });
}

function validatePriorCheckpoint(value: unknown, issues: RuntimeContractValidationIssue[]): void {
  if (value === null) return;
  const item = record(value, 'priorCheckpoint', issues);
  if (!item) return;
  positiveInteger(item.executionId, 'priorCheckpoint.executionId', issues);
  positiveInteger(item.checkpointId, 'priorCheckpoint.checkpointId', issues);
  if (!Number.isInteger(item.sequence) || Number(item.sequence) < 0) {
    issues.push({ path: 'priorCheckpoint.sequence', message: 'must be a non-negative integer' });
  }
  nonEmptyString(item.boundaryFingerprint, 'priorCheckpoint.boundaryFingerprint', issues);
}

export function validateRuntimeBoundaryV1(value: unknown): RuntimeContractValidationResult {
  const issues: RuntimeContractValidationIssue[] = [];
  const boundary = record(value, '$', issues);
  if (!boundary) return { ok: false, issues };
  if (boundary.version !== RUNTIME_BOUNDARY_VERSION) {
    issues.push({ path: 'version', message: `must equal ${RUNTIME_BOUNDARY_VERSION}` });
  }
  validateIdentity(boundary.identity, issues);
  validateRuntime(boundary.runtime, issues);
  validateWorkspace(boundary.workspace, issues);

  const prompt = record(boundary.prompt, 'prompt', issues);
  if (prompt) nonEmptyString(prompt.bundleFingerprint, 'prompt.bundleFingerprint', issues);
  validateExecutionTarget(boundary.executionTarget, issues);
  validateTools(boundary.tools, issues);
  validateAuth(boundary.auth, issues);

  const evidence = record(boundary.evidence, 'evidence', issues);
  if (evidence) {
    if (typeof evidence.required !== 'boolean') issues.push({ path: 'evidence.required', message: 'must be a boolean' });
    stringSet(evidence.requirements, 'evidence.requirements', issues);
  }
  const callback = record(boundary.callback, 'callback', issues);
  if (callback) nonEmptyString(callback.identity, 'callback.identity', issues);
  validatePriorCheckpoint(boundary.priorCheckpoint, issues);
  const observability = record(boundary.observability, 'observability', issues);
  if (observability) {
    nonEmptyString(observability.traceId, 'observability.traceId', issues);
    nonEmptyString(observability.correlationId, 'observability.correlationId', issues);
    nullableString(observability.requestedBy, 'observability.requestedBy', issues);
  }

  return issues.length ? { ok: false, issues } : { ok: true, issues: [] };
}

export function assertRuntimeBoundaryV1(value: unknown): asserts value is RuntimeBoundaryV1 {
  const result = validateRuntimeBoundaryV1(value);
  if (!result.ok) {
    throw new Error(`Invalid RuntimeBoundaryV1: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
}

export function validateRuntimeCheckpointV1(value: unknown): RuntimeContractValidationResult {
  const issues: RuntimeContractValidationIssue[] = [];
  const checkpoint = record(value, '$', issues);
  if (!checkpoint) return { ok: false, issues };
  if (checkpoint.version !== RUNTIME_CHECKPOINT_VERSION) {
    issues.push({ path: 'version', message: `must equal ${RUNTIME_CHECKPOINT_VERSION}` });
  }
  positiveInteger(checkpoint.id, 'id', issues);
  positiveInteger(checkpoint.tenantId, 'tenantId', issues);
  positiveInteger(checkpoint.executionId, 'executionId', issues);
  if (!Number.isInteger(checkpoint.sequence) || Number(checkpoint.sequence) < 0) {
    issues.push({ path: 'sequence', message: 'must be a non-negative integer' });
  }
  if (!RUNTIME_CHECKPOINT_KINDS.includes(checkpoint.kind as RuntimeCheckpointKind)) {
    issues.push({ path: 'kind', message: 'has an unsupported value' });
  }
  if (!RUNTIME_EXECUTION_STATES.includes(checkpoint.state as RuntimeExecutionState)) {
    issues.push({ path: 'state', message: 'has an unsupported value' });
  }
  nullableString(checkpoint.sessionId, 'sessionId', issues);
  nonEmptyString(checkpoint.boundaryFingerprint, 'boundaryFingerprint', issues);
  if (checkpoint.transcriptCursor !== null) record(checkpoint.transcriptCursor, 'transcriptCursor', issues);
  record(checkpoint.data, 'data', issues);
  nonEmptyString(checkpoint.createdAt, 'createdAt', issues);
  return issues.length ? { ok: false, issues } : { ok: true, issues: [] };
}

export function assertRuntimeCheckpointV1(value: unknown): asserts value is RuntimeCheckpointV1 {
  const result = validateRuntimeCheckpointV1(value);
  if (!result.ok) {
    throw new Error(`Invalid RuntimeCheckpointV1: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function boundaryFingerprintMaterial(boundary: RuntimeBoundaryV1): unknown {
  return {
    version: boundary.version,
    identity: boundary.identity,
    runtime: boundary.runtime,
    workspace: boundary.workspace,
    prompt: boundary.prompt,
    executionTarget: {
      ...boundary.executionTarget,
      capabilities: sortStrings(boundary.executionTarget.capabilities),
    },
    tools: {
      builtIn: sortStrings(boundary.tools.builtIn),
      requiredLifecycleTools: sortStrings(boundary.tools.requiredLifecycleTools),
      mcpServers: boundary.tools.mcpServers
        .map((server) => ({ ...server, requiredToolNames: sortStrings(server.requiredToolNames) }))
        .sort((a, b) => `${a.name}:${a.configFingerprint}`.localeCompare(`${b.name}:${b.configFingerprint}`)),
      skills: [...boundary.tools.skills]
        .sort((a, b) => `${a.name}:${a.revision ?? ''}`.localeCompare(`${b.name}:${b.revision ?? ''}`)),
      registryTools: [...boundary.tools.registryTools]
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    },
    auth: {
      ...boundary.auth,
      credentialRefs: [...boundary.auth.credentialRefs]
        .sort((a, b) => `${a.kind}:${a.reference}`.localeCompare(`${b.kind}:${b.reference}`)),
    },
    evidence: {
      ...boundary.evidence,
      requirements: sortStrings(boundary.evidence.requirements),
    },
    callback: boundary.callback,
  };
}

/** Stable JSON independent of object insertion order. Arrays remain ordered. */
export function canonicalRuntimeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRuntimeJson).join(',')}]`;
  const entries = Object.entries(value as UnknownRecord)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalRuntimeJson(child)}`).join(',')}}`;
}

/**
 * Resume fingerprint. priorCheckpoint and observability are excluded because
 * they change during recovery; identity, repo/cwd, prompt, model policy, MCP,
 * credentials-by-reference, callback, and target capability contract are exact.
 */
export function fingerprintRuntimeBoundaryV1(boundary: RuntimeBoundaryV1): string {
  assertRuntimeBoundaryV1(boundary);
  const hash = createHash('sha256')
    .update(`runtime-boundary-v${boundary.version}\n`)
    .update(canonicalRuntimeJson(boundaryFingerprintMaterial(boundary)))
    .digest('hex');
  return `sha256:${hash}`;
}

const ALLOWED_STATE_TRANSITIONS: Record<RuntimeExecutionState, readonly RuntimeExecutionState[]> = {
  preparing: ['starting', 'failed', 'cancelled', 'lost'],
  starting: ['running', 'interrupting', 'failed', 'cancelled', 'lost'],
  running: ['interrupting', 'succeeded', 'failed', 'cancelled', 'lost'],
  interrupting: ['cancelled', 'failed', 'lost'],
  succeeded: [],
  failed: [],
  cancelled: [],
  lost: [],
};

/** Same-state writes are valid idempotent retries; terminal states never reopen. */
export function isRuntimeExecutionTransitionAllowed(
  from: RuntimeExecutionState,
  to: RuntimeExecutionState,
): boolean {
  return from === to || ALLOWED_STATE_TRANSITIONS[from].includes(to);
}
