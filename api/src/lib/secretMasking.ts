/**
 * Read endpoints return secrets masked; write endpoints accept the mask back as "unchanged".
 *
 * Settings screens load a record, let the operator edit it, and send the whole record back.
 * Masking on read alone would make that round trip overwrite every secret with its mask, so
 * each writer that accepts a secret also recognises the mask of the value it already holds and
 * keeps the stored value. A mask never matches a different secret: it is derived from the
 * stored value, not a fixed placeholder.
 */
const MASK = '********';

/** At most the last four characters survive, and only of a value long enough to spare them. */
export function maskSecret(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value) return '';
  return value.length >= 16 ? `${MASK}${value.slice(-4)}` : MASK;
}

/** True when `submitted` is the mask a read endpoint returned for `stored`. */
export function isMaskOf(submitted: unknown, stored: string | null | undefined): boolean {
  return typeof submitted === 'string' && typeof stored === 'string' && stored.length > 0
    && submitted === maskSecret(stored);
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
}

/** Masks every value of an environment map, keeping the keys. Accepts the stored JSON text. */
export function maskEnvRecord(env: unknown): Record<string, string> {
  const record = parseRecord(env) ?? {};
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, maskSecret(stringValue(value))]));
}

/**
 * MCP server rows carry launch credentials in `env`, and assignment rows can override them in
 * `overrides.env`. Both keep their keys, so the operator can still see what is configured.
 */
export function redactMcpServerRow<T extends Record<string, unknown> | undefined>(row: T): T {
  if (!row) return row;
  const redacted: Record<string, unknown> = { ...row };
  if ('env' in redacted) redacted.env = JSON.stringify(maskEnvRecord(redacted.env));
  if ('overrides' in redacted) {
    const overrides = parseRecord(redacted.overrides);
    if (overrides && 'env' in overrides) {
      redacted.overrides = JSON.stringify({ ...overrides, env: maskEnvRecord(overrides.env) });
    }
  }
  return redacted as T;
}

/**
 * Replaces each submitted value that is still the mask of the stored value for the same key
 * with the stored value. Keys the caller dropped stay dropped; new or edited values win.
 */
export function restoreMaskedEnvValues(submitted: unknown, stored: unknown): unknown {
  const next = parseRecord(submitted);
  if (!next) return submitted;
  const previous = parseRecord(stored) ?? {};
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    const storedValue = Object.prototype.hasOwnProperty.call(previous, key) ? stringValue(previous[key]) : null;
    restored[key] = storedValue !== null && isMaskOf(value, storedValue) ? previous[key] : value;
  }
  return restored;
}
