'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Building2, Check, Loader2, Plus, Trash2, X } from 'lucide-react';
import { api, Tenant } from '@/lib/api';

export default function SettingsCompaniesPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [activeTenantId, setActiveTenantId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getTenants();
      setTenants(result.tenants);
      setActiveTenantId(result.active_tenant_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createTenant(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await api.createTenant({ name: trimmed, set_active: true });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function selectTenant(id: number) {
    setSaving(true);
    setError(null);
    try {
      const result = await api.selectTenant(id);
      setActiveTenantId(result.active_tenant_id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function beginDeleteTenant(tenant: Tenant) {
    setDeleteTarget(tenant);
    setDeleteConfirmation('');
    setError(null);
  }

  async function deleteTenant(event: React.FormEvent) {
    event.preventDefault();
    if (!deleteTarget || deleteConfirmation.trim() !== deleteTarget.name) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await api.deleteTenant(deleteTarget.id, deleteConfirmation.trim());
      setTenants(result.tenants);
      setActiveTenantId(result.active_tenant_id);
      setDeleteTarget(null);
      setDeleteConfirmation('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Tenants</h2>
          <p className="text-sm text-slate-400">Create isolated Agent HQ workspaces and choose the active tenant context.</p>
        </div>
      </div>

      <form onSubmit={createTenant} className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-950 p-4 sm:flex-row">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Tenant name"
          className="min-h-10 flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-white outline-none focus:border-amber-400"
        />
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-amber-500 px-4 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create
        </button>
      </form>

      {error && <div className="rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">{error}</div>}

      <div className="rounded-lg border border-slate-800 bg-slate-950">
        {loading ? (
          <div className="flex h-28 items-center justify-center text-slate-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading tenants
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {tenants.map((tenant) => {
              const active = tenant.id === activeTenantId;
              const isDefault = Boolean(tenant.is_default);
              return (
                <div key={tenant.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-white">{tenant.name}</h3>
                        {tenant.is_default ? <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">Default</span> : null}
                        {active ? <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 text-xs text-emerald-200">Active</span> : null}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {tenant.project_count ?? 0} projects · {tenant.task_count ?? 0} tasks · {tenant.agent_count ?? 0} agents
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <button
                      type="button"
                      disabled={saving || active}
                      onClick={() => selectTenant(tenant.id)}
                      className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 hover:border-slate-500 disabled:cursor-default disabled:opacity-60"
                    >
                      {active ? <Check className="h-4 w-4" /> : null}
                      {active ? 'Selected' : 'Select'}
                    </button>
                    <button
                      type="button"
                      disabled={saving || deleting || isDefault}
                      onClick={() => beginDeleteTenant(tenant)}
                      title={isDefault ? 'The default tenant cannot be deleted from Settings' : `Delete ${tenant.name}`}
                      className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-red-900/70 px-3 text-sm text-red-200 hover:border-red-700 hover:bg-red-950/30 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <form onSubmit={deleteTenant} className="w-full max-w-lg rounded-lg border border-red-900/80 bg-slate-950 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
                <div>
                  <h2 className="text-base font-semibold text-white">Delete {deleteTarget.name}</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    This permanently removes the tenant and its tenant-owned projects, workflows, tasks, agents, routing config,
                    MCP and API keys, recurring tasks, sessions, chat data, and related settings. Other tenants are left intact.
                  </p>
                  {deleteTarget.id === activeTenantId ? (
                    <p className="mt-2 text-sm text-amber-200">
                      This is the active tenant. Agent HQ will switch to a remaining tenant after deletion.
                    </p>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-900 hover:text-white"
                aria-label="Close delete tenant confirmation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <label className="mt-5 block text-sm font-medium text-slate-200" htmlFor="tenant-delete-confirmation">
              Type {deleteTarget.name} to confirm
            </label>
            <input
              id="tenant-delete-confirmation"
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              className="mt-2 min-h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-white outline-none focus:border-red-400"
              autoComplete="off"
            />

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="inline-flex min-h-10 items-center justify-center rounded-md border border-slate-700 px-4 text-sm text-slate-200 hover:border-slate-500"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={deleting || deleteConfirmation.trim() !== deleteTarget.name}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-red-500 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete tenant
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
