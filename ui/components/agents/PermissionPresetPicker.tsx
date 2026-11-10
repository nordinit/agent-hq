'use client';
import {useEffect,useState} from 'react';
import {apiFetch} from '@/lib/api/http';

export function PermissionPresetPicker({onSelect,disabled}:{onSelect:(keys:string[])=>void;disabled:boolean}) {
  const [presets,setPresets]=useState<Record<string,string[]>>({});
  const [selected,setSelected]=useState('');
  const [error,setError]=useState('');
  useEffect(()=>{let active=true;apiFetch<{presets:Record<string,string[]>}>('/api/v1/execution/presets').then(r=>{if(active)setPresets(r.presets);}).catch(()=>{if(active)setError('Permission presets are unavailable.');});return()=>{active=false;};},[]);
  return <div className="rounded-xl border border-slate-700 p-4 space-y-3">
    <p className="text-sm text-slate-200">Project observation, registry authoring, publication, assignment and execution are independent grants. Business administration does not enable host execution.</p>
    <div className="flex flex-wrap gap-3 items-center"><label className="text-sm text-slate-300">Permission preset <select className="ml-2 rounded bg-slate-900 border border-slate-700 p-2" value={selected} disabled={disabled} onChange={e=>setSelected(e.target.value)}><option value="">Select a preset</option>{Object.keys(presets).map(k=><option key={k} value={k}>{k.replaceAll('_',' ')}</option>)}</select></label><button type="button" className="rounded bg-slate-700 px-3 py-2 text-sm text-white disabled:opacity-40" disabled={disabled||!presets[selected]} onClick={()=>onSelect([...presets[selected]])}>Apply to draft</button></div>
    {selected&&<p className="text-xs text-slate-400">This replaces the draft with: {presets[selected]?.join(', ')}. Preview and save are separate actions; selecting a preset grants nothing.</p>}
    <p className="text-xs text-slate-400">Read all projects stays within this workspace. Published tool revisions, execution bindings and runtime ownership are checked separately on invocation. Files, credentials and cross-tenant access are excluded.</p>
    {error&&<p role="alert" className="text-sm text-amber-300">{error}</p>}
  </div>;
}
