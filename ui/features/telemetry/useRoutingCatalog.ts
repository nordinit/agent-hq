'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { telemetryClient } from '@/lib/api/telemetry';
import { telemetryErrorMessage } from '@/lib/telemetryPresentation';
import type { TelemetryRoutingCatalog, TelemetryRoutingSignal } from '@/lib/telemetryTypes';

type Session = { key: string; controller: AbortController; pending: boolean; nextOffset: number | null };
type State = { key: string; data: TelemetryRoutingCatalog | null; busy: boolean; error: string | null };
const merge = (before: TelemetryRoutingSignal[], after: TelemetryRoutingSignal[]) => [...new Map([...before, ...after].map(row => [row.id, row])).values()];

/** Optional discovery must not hold up the catalog, saved metrics, or calculations. */
export function useRoutingCatalog(scopeKey: string, enabled: boolean) {
  const session = useRef<Session | null>(null);
  const [state, setState] = useState<State>({ key: scopeKey, data: null, busy: false, error: null });
  const load = useCallback(async (current: Session) => {
    if (current.pending || current.controller.signal.aborted || current.nextOffset == null) return;
    const offset = current.nextOffset;
    current.pending = true;
    setState(previous => ({ ...previous, busy: true, error: null }));
    try {
      const page = await telemetryClient.getTelemetryRoutingCatalog(JSON.parse(current.key), { offset }, current.controller.signal);
      if (session.current !== current || current.controller.signal.aborted) return;
      current.nextOffset = page.routing_pagination.next_offset;
      setState(previous => ({ key: current.key, busy: false, error: null, data: {
        ...page,
        routing_transitions: merge(offset ? previous.data?.routing_transitions ?? [] : [], page.routing_transitions),
        event_mappings: merge(offset ? previous.data?.event_mappings ?? [] : [], page.event_mappings),
      } }));
    } catch (cause) {
      if (session.current === current && !current.controller.signal.aborted) setState(previous => ({ ...previous, busy: false, error: telemetryErrorMessage(cause) }));
    } finally { current.pending = false; }
  }, []);

  useEffect(() => {
    const current: Session = { key: scopeKey, controller: new AbortController(), pending: false, nextOffset: 0 };
    session.current = current;
    setState({ key: scopeKey, data: null, busy: enabled, error: null });
    if (enabled) void load(current);
    return () => { current.controller.abort(); };
  }, [scopeKey, enabled, load]);

  const loadMore = useCallback(() => {
    if (enabled && session.current?.key === scopeKey) void load(session.current);
  }, [scopeKey, enabled, load]);
  // Hide old-scope rows immediately, even before the effect aborts the old request.
  return { ...(state.key === scopeKey && enabled ? state : { data: null, busy: enabled, error: null }), loadMore };
}
