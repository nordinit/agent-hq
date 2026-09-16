'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { telemetryClient } from '@/lib/api/telemetry';
import type { TelemetryBinding, TelemetryScope } from '@/lib/telemetryTypes';
import { telemetryErrorMessage, telemetryScopeQuery, telemetryBindingScopeLabel } from '@/lib/telemetryPresentation';
import { BindingHealthNotice, ErrorNotice } from './TelemetryControls';

export default function TelemetryScopeSummary({ scope }: { scope: TelemetryScope }) {
  const [bindings, setBindings] = useState<TelemetryBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    telemetryClient.getTelemetryBindings(JSON.parse(scopeKey), controller.signal).then(response => { if (!controller.signal.aborted) setBindings(response.bindings); }).catch(cause => { if (!controller.signal.aborted) setError(telemetryErrorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [scopeKey]);
  return <div className="space-y-4"><div><h3 className="font-semibold text-white">Configured measurements</h3><p className="mt-2 text-sm text-slate-400">Define success, rework, blockage, and custom-field calculations for this workflow. Scoped bindings override broader defaults; definitions retain their own revisions.</p></div><ErrorNotice message={error}/>{loading ? <p className="text-sm text-slate-500">Loading scoped metric bindings…</p> : !bindings.length ? <p className="text-sm text-slate-500">No metric bindings are configured for this scope.</p> : <ul className="space-y-2">{bindings.map((binding, index) => <li key={binding.id ?? index} className="rounded-lg border border-slate-700/50 p-3 text-sm"><span className="text-white">{binding.family_key}</span><span className="ml-3 text-xs text-slate-400">{binding.disabled ? 'Disabled' : telemetryBindingScopeLabel(binding.scope)}</span><p className="mt-1 text-xs text-slate-500">{Object.entries(binding.scope).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`).join(' · ') || 'Tenant default'}</p><BindingHealthNotice binding={binding}/></li>)}</ul>}<div className="flex flex-wrap gap-4 text-sm"><Link className="text-amber-300 hover:underline" href={`/telemetry${telemetryScopeQuery({ ...scope, tab: 'bindings' })}`}>Inspect inheritance and overrides →</Link><Link className="text-amber-300 hover:underline" href={`/telemetry${telemetryScopeQuery({ ...scope })}`}>Create or query a metric →</Link></div></div>;
}
