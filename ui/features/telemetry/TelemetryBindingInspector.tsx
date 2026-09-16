'use client';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { telemetryClient } from '@/lib/api/telemetry';
import { telemetryBindingPreviewRequest, type TelemetryBindingReview } from '@/lib/telemetryBindings';
import { telemetryBindingScopeLabel, telemetryErrorMessage } from '@/lib/telemetryPresentation';
import type { TelemetryBinding, TelemetryBindingPreview, TelemetryBindingResolution, TelemetryMetric, TelemetryScope } from '@/lib/telemetryTypes';
import { BindingHealthNotice, ErrorNotice } from './TelemetryControls';

function BindingDetail({ binding, metrics }: { binding: TelemetryBinding; metrics: TelemetryMetric[] }) {
  const metric = metrics.find(item => item.latest_revision_id === binding.metric_revision_id || item.revisions?.some(revision => revision.id === binding.metric_revision_id));
  const revision = metric?.revisions?.find(item => item.id === binding.metric_revision_id)?.revision ?? (metric && metric.latest_revision_id === binding.metric_revision_id ? metric.revision : undefined);
  return <div className="text-xs"><p className="font-medium text-slate-200">{binding.disabled ? 'Explicitly disabled — inheritance stops here' : metric ? `${metric.name}${revision ? ` · revision ${revision}` : ''}` : `Metric revision ${binding.metric_revision_id ?? 'not selected'}`}</p><p className="mt-1 text-slate-400">{telemetryBindingScopeLabel(binding.scope)}</p><p className="mt-1 break-words text-slate-500">{Object.entries(binding.scope).filter(([key]) => key !== 'include_archived').map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`).join(' · ') || 'Applies at the tenant default scope'}</p>{binding.profile_revision_id && <p className="mt-1 text-slate-500">Profile revision {binding.profile_revision_id}</p>}<BindingHealthNotice binding={binding}/></div>;
}
function Resolution({ title, resolution, metrics }: { title: string; resolution: TelemetryBindingResolution; metrics: TelemetryMetric[] }) {
  return <section className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3"><div className="mb-3 flex items-center justify-between gap-2"><h4 className="text-sm font-medium text-white">{title}</h4><Badge variant={resolution.winner?.disabled ? 'warn' : resolution.origin === 'unbound' ? 'default' : 'info'}>{resolution.origin === 'exact' ? 'Defined here' : resolution.origin === 'inherited' ? 'Inherited' : 'Unbound'}</Badge></div>
    {resolution.winner ? <BindingDetail binding={resolution.winner} metrics={metrics}/> : <p className="text-xs text-slate-400">No definition applies at this selected scope.</p>}
    {resolution.shadowed.length > 0 && <details className="mt-3 border-t border-slate-700/50 pt-3"><summary className="cursor-pointer text-xs text-slate-400">{resolution.shadowed.length} broader {resolution.shadowed.length === 1 ? 'binding is' : 'bindings are'} shadowed</summary><ul className="mt-3 space-y-3">{resolution.shadowed.map((binding, index) => <li key={binding.id ?? index}><BindingDetail binding={binding} metrics={metrics}/></li>)}</ul></details>}
  </section>;
}
export default function TelemetryBindingInspector({ binding, scope, metrics, refreshKey, onReviewed }: {
  binding: TelemetryBinding; scope: TelemetryScope; metrics: TelemetryMetric[]; refreshKey: string;
  onReviewed: (review: TelemetryBindingReview | null) => void;
}) {
  const request = telemetryBindingPreviewRequest(binding, scope);
  const requestKey = request ? JSON.stringify(request) : '';
  const [preview, setPreview] = useState<TelemetryBindingPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); onReviewed(null); setPreview(null); setError(null);
    if (!requestKey) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    const timer = setTimeout(() => {
      telemetryClient.previewTelemetryBinding(JSON.parse(requestKey), controller.signal).then(response => {
        if (controller.signal.aborted) return;
        setPreview(response); onReviewed({ requestKey, preview: response });
      }).catch(cause => { if (!controller.signal.aborted) setError(telemetryErrorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [requestKey, refreshKey, onReviewed]);
  if (!request) return <p className="mt-4 text-xs text-slate-500">Enter a family key to inspect its effective definition and inheritance before editing.</p>;
  return <div className="mt-5 space-y-3 border-t border-slate-700/60 pt-4"><h3 className="text-sm font-medium text-white">Binding resolution preview</h3>
    {loading && <p role="status" className="text-xs text-slate-400">Resolving the current binding and proposed override…</p>}
    <ErrorNotice message={error}/>
    {preview && <>
      <div className={`grid gap-3 ${preview.proposed ? 'lg:grid-cols-2' : ''}`}><Resolution title="Current effective definition" resolution={preview.current} metrics={metrics}/>{preview.proposed && <Resolution title="After this save" resolution={preview.proposed} metrics={metrics}/>}</div>
      {preview.effect && <p className="text-xs text-slate-400">{preview.effect === 'create' ? 'This creates an exact binding at the selected scope.' : preview.effect === 'replace' ? 'This replaces the existing binding at the selected scope.' : preview.effect === 'disable' ? 'This disables the family at the selected scope and stops broader inheritance.' : 'This selection preserves the existing binding meaning.'}</p>}
      {(preview.proposed ?? preview.current).narrower.length > 0 && <details className="rounded-lg border border-amber-500/20 bg-amber-950/10 p-3"><summary className="cursor-pointer text-xs text-amber-200">{(preview.proposed ?? preview.current).narrower.length} more specific overrides exist inside this scope</summary><p className="mt-2 text-xs text-slate-400">The preview shows the default for the selected context. Select a workflow and task type to inspect its exact winner. More specific overrides continue to take precedence.</p><ul className="mt-3 space-y-3">{(preview.proposed ?? preview.current).narrower.map((item, index) => <li key={item.id ?? index}><BindingDetail binding={item} metrics={metrics}/></li>)}</ul></details>}
      {!preview.proposed && <p className="text-xs text-slate-500">Select a metric revision or choose Disable to preview a change. No binding has been saved.</p>}
    </>}
  </div>;
}
