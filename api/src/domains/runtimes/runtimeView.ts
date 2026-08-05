import { redactSensitiveRuntimeText } from '../../runtimes/sensitiveText';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonValue(value);
  return isRecord(parsed) ? parsed : null;
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

export function redactRuntimeMetadata(value: unknown, key = ''): unknown {
  if (/(^|[_-])(token|secret|password|credential|api[_-]?key|auth[_-]?header)([_-]|$)/i.test(key)) {
    return '[redacted]';
  }
  if (Array.isArray(value)) return value.map((entry) => redactRuntimeMetadata(entry));
  if (typeof value === 'string') return redactSensitiveRuntimeText(value);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactRuntimeMetadata(childValue, childKey),
    ]),
  );
}

/** Map migration 18's durable columns onto the stable operator-facing shape. */
export function mapRuntimeExecutionRow(
  row: Record<string, unknown>,
  defaults: { instanceId: number; runtimeType: string; state: string },
): Record<string, unknown> {
  return {
    id: row.id ?? null,
    instance_id: row.instance_id ?? defaults.instanceId,
    driver_type: row.driver ?? defaults.runtimeType,
    backend_type: row.backend ?? null,
    execution_target_id: row.execution_target_id ?? null,
    state: row.state ?? defaults.state,
    session_id: row.session_id ?? null,
    boundary_version: row.boundary_version ?? null,
    boundary: redactRuntimeMetadata(parseJsonRecord(row.boundary_json)),
    launch_spec: redactRuntimeMetadata(parseJsonRecord(row.sanitized_launch_spec)),
    handle: redactRuntimeMetadata(parseJsonRecord(row.opaque_handle)),
    checkpoint_fingerprint: row.boundary_fingerprint ?? null,
    capabilities: redactRuntimeMetadata(parseJsonArray(row.capability_snapshot)),
    lease_expires_at: row.lease_expires_at ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    started_at: row.started_at ?? null,
    ended_at: row.ended_at ?? null,
    terminal_reason: row.terminal_reason ?? null,
    error: redactRuntimeMetadata(row.terminal_error ?? null),
  };
}
