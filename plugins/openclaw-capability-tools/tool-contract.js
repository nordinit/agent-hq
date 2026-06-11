const SUPPORTED_EXECUTION_TYPES = new Set(['shell', 'script', 'http']);
const OPENCLAW_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DEFAULT_TOOL_TIMEOUT_MS = 180_000;

function normalizeOpenClawAgentId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !OPENCLAW_AGENT_ID_RE.test(raw)) return null;
  return raw.toLowerCase();
}

function resolveAgentIdFromSessionKey(sessionKey) {
  const raw = typeof sessionKey === 'string' ? sessionKey.trim().toLowerCase() : '';
  if (!raw) return null;
  const parts = raw.split(':').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'agent') return null;
  return normalizeOpenClawAgentId(parts[1]);
}

export function resolveOpenClawAgentId(context) {
  const direct = normalizeOpenClawAgentId(context?.agentId);
  if (direct) return direct;

  const nested = normalizeOpenClawAgentId(context?.agent?.id);
  if (nested) return nested;

  return resolveAgentIdFromSessionKey(context?.sessionKey);
}

export function normalizeInputSchema(schema) {
  return schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : { type: 'object', additionalProperties: true };
}

export function normalizeMaterializedTools(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  return tools.filter((tool) => SUPPORTED_EXECUTION_TYPES.has(tool?.execution_type));
}

export function toOpenClawToolDefinition(tool) {
  return {
    name: tool.slug,
    label: tool.name,
    description: tool.description,
    parameters: normalizeInputSchema(tool.input_schema),
    metadata: {
      tags: Array.isArray(tool.tags) ? tool.tags : [],
      permissions: tool.permissions,
      agentHqToolId: tool.tool_id ?? tool.id,
      agentHqAssignmentId: tool.assignment_id,
    },
  };
}

export function resolveExecutionTimeoutMs(execution) {
  const value = execution?.timeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TOOL_TIMEOUT_MS;
}

function serializeEnvValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function buildToolExecutionEnv(input, executionEnv = {}, baseEnv = process.env) {
  const normalizedInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const directInputEnv = Object.fromEntries(
    Object.entries(normalizedInput)
      .filter(([key]) => ENV_NAME_RE.test(key) && !(key in baseEnv) && !(key in executionEnv))
      .map(([key, value]) => [key, serializeEnvValue(value)]),
  );

  return {
    ...baseEnv,
    ...executionEnv,
    ...directInputEnv,
    TOOL_INPUT: JSON.stringify(normalizedInput),
    ...Object.fromEntries(
      Object.entries(normalizedInput).map(([key, value]) => [
        `TOOL_${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`,
        serializeEnvValue(value),
      ]),
    ),
  };
}
