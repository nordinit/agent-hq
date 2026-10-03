/** Only missing/expired/revoked calculations are recoverable. Permissions and
 * invalid metric definitions must surface directly instead of retrying. */
export function isTelemetryResultUnavailable(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const error = cause as { code?: string; status?: number; message?: string };
  return (error.status === 410 && error.code === 'result_expired') ||
    (error.status === 409 && error.code === 'result_unavailable') ||
    (error.status === 404 && error.code === 'not_found' && error.message === 'Query result not found.');
}

/** One automatic attempt per binding/query configuration, even after a new
 * query ID is installed. Concurrent widgets share the same recovery request. */
export function createTelemetryRecoveryGate() {
  const attempted = new Set<string>(), pending = new Map<string, Promise<boolean>>();
  return {
    run(key: string, action: () => Promise<void>, manual = false): Promise<boolean> {
      const existing = pending.get(key); if (existing) return existing;
      if (!manual && attempted.has(key)) return Promise.resolve(false);
      attempted.add(key);
      const request = Promise.resolve().then(action).then(() => true).finally(() => pending.delete(key));
      pending.set(key, request); return request;
    },
  };
}

export type TelemetryRecovery = (queryId: string, manual?: boolean) => Promise<boolean>;
