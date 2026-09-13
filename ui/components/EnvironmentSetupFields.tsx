'use client';

import type { EnvironmentSetup } from '@/lib/api';

const fieldClass = 'w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm';
export function EnvironmentSetupFields({ value, onChange }: {
  value: EnvironmentSetup;
  onChange: (value: EnvironmentSetup) => void;
}) {
  return <fieldset className="space-y-3 border-t border-slate-700 pt-4">
    <legend className="text-sm font-medium text-white pt-4">Environment preparation</legend>
    <label className="block text-xs text-slate-400">Preparation mode
      <select className={fieldClass + ' mt-1'} value={value.mode} onChange={event => {
        const mode = event.target.value;
        onChange(mode === 'auto' ? { mode, roots: ['.'], timeoutSeconds: 600 }
          : mode === 'custom' ? { mode, steps: [{ command: ['./scripts/setup'], cwd: '.' }], timeoutSeconds: 600 }
            : { mode: 'off' });
      }}>
        <option value="off">Off — repository access only</option>
        <option value="auto">Automatic — use the project’s build tool</option>
        <option value="custom">Custom — run setup commands</option>
      </select>
    </label>
    <p className="text-xs text-slate-500">Repository access and environment preparation are independent. Enable preparation for workflows that need to build, test, or run code.</p>
    {value.mode === 'auto' && <label className="block text-xs text-slate-400">Project folders (one per line)
      <textarea className={fieldClass + ' mt-1 font-mono'} rows={3} value={value.roots.join('\n')}
        onChange={event => onChange({ ...value, roots: event.target.value.split('\n') })} />
      <span className="block mt-1">Use . for the repository root, or folders such as api and ui. Only these folders are prepared. A workspace-aware package manager may include its declared packages.</span>
    </label>}
    {value.mode === 'custom' && <div className="space-y-3">
      <p className="text-xs text-slate-500">Commands run in order before the agent starts. Use a project script or a tool such as mise for any language or toolchain. Executables must be available on the agent host.</p>
      {value.steps.map((step, index) => {
        const update = (patch: Partial<typeof step>) => onChange({ ...value, steps: value.steps.map((item, i) => i === index ? { ...item, ...patch } : item) });
        return <div key={index} className="space-y-2 rounded-lg border border-slate-700 p-3">
          <label className="block text-xs text-slate-400">Executable
            <input className={fieldClass + ' mt-1 font-mono'} value={step.command[0]} placeholder="./scripts/setup" onChange={event => update({ command: [event.target.value, ...step.command.slice(1)] })} />
          </label>
          {step.command.slice(1).map((argument, argumentIndex) => <div key={argumentIndex} className="flex gap-2">
            <input aria-label={`Command ${index + 1} argument ${argumentIndex + 1}`} className={fieldClass + ' font-mono'} value={argument}
              onChange={event => update({ command: step.command.map((arg, i) => i === argumentIndex + 1 ? event.target.value : arg) })} />
            <button type="button" className="text-xs text-slate-400" onClick={() => update({ command: step.command.filter((_, i) => i !== argumentIndex + 1) })}>Remove argument</button>
          </div>)}
          <button type="button" className="text-xs text-amber-400" onClick={() => update({ command: [...step.command, ''] })}>Add argument</button>
          <label className="block text-xs text-slate-400">Working directory
            <input className={fieldClass + ' mt-1 font-mono'} value={step.cwd} onChange={event => update({ cwd: event.target.value })} />
          </label>
          {value.steps.length > 1 && <button type="button" className="text-xs text-slate-400" onClick={() => onChange({ ...value, steps: value.steps.filter((_, i) => i !== index) })}>Remove command</button>}
        </div>;
      })}
      <button type="button" className="text-xs text-amber-400" onClick={() => onChange({ ...value, steps: [...value.steps, { command: [''], cwd: '.' }] })}>Add setup command</button>
    </div>}
    {value.mode !== 'off' && <label className="block text-xs text-slate-400">Maximum setup time (seconds)
      <input type="number" min={1} max={3600} className={fieldClass + ' mt-1'} value={value.timeoutSeconds} onChange={event => onChange({ ...value, timeoutSeconds: Number(event.target.value) })} />
    </label>}
  </fieldset>;
}
