'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Team } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronRight, Plus, Trash2, Users, X } from 'lucide-react';

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Team | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getTeams()
      .then(setTeams)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createTeam({ name: newName.trim(), goal: newGoal.trim() });
      setTeams(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName('');
      setNewGoal('');
      setShowCreate(false);
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (team: Team) => {
    try {
      await api.deleteTeam(team.id);
      setTeams(prev => prev.filter(t => t.id !== team.id));
      setDeleteTarget(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100 flex items-center gap-2">
            <Users className="w-6 h-6" /> Teams
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            A team gives its members a shared goal, mutual awareness of who else is working the
            same problem, a default capability bundle, and a reusable routing shape.
          </p>
        </div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1" /> New team
        </Button>
      </div>

      {error && <Card className="p-4 border-red-800 text-red-300 text-sm">{error}</Card>}

      {showCreate && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-200">New team</h2>
            <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          <input
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100"
            placeholder="Team name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
          <textarea
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100"
            placeholder="Shared goal — this text is injected into every member's prompt"
            rows={2}
            value={newGoal}
            onChange={e => setNewGoal(e.target.value)}
          />
          {createError && <p className="text-sm text-red-400">{createError}</p>}
          <div className="flex gap-2">
            <Button variant="primary" onClick={handleCreate} disabled={creating || !newName.trim()}>
              {creating ? 'Creating…' : 'Create'}
            </Button>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : teams.length === 0 ? (
        <Card className="p-8 text-center text-slate-400 text-sm">
          No teams yet. Create one to give a group of agents a shared goal and a routing shape.
        </Card>
      ) : (
        <div className="space-y-2">
          {teams.map(team => (
            <Card key={team.id} className="p-4 flex items-center justify-between gap-4">
              <Link href={`/teams/${team.id}`} className="flex-1 min-w-0 group">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-100 group-hover:text-white">{team.name}</span>
                  {!team.enabled && <Badge variant="default">disabled</Badge>}
                </div>
                {team.goal && <p className="text-sm text-slate-400 mt-1 truncate">{team.goal}</p>}
                <div className="flex gap-3 mt-2 text-xs text-slate-500">
                  <span>{team.member_count ?? 0} member{team.member_count === 1 ? '' : 's'}</span>
                  <span>{team.workflow_count ?? 0} workflow{team.workflow_count === 1 ? '' : 's'}</span>
                  <span>context v{team.context_version}</span>
                </div>
              </Link>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setDeleteTarget(team)}
                  className="text-slate-500 hover:text-red-400 p-2"
                  aria-label={`Delete ${team.name}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <Link href={`/teams/${team.id}`} className="text-slate-400 hover:text-slate-200">
                  <ChevronRight className="w-5 h-5" />
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <Card className="p-5 max-w-md w-full space-y-3">
            <h2 className="text-slate-100 font-medium">Delete {deleteTarget.name}?</h2>
            <p className="text-sm text-slate-400">
              Workflows keep their assignment and any routing rules this team materialized stay in
              place — they simply become locally owned. Nothing mid-flight breaks.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => handleDelete(deleteTarget)}>Delete</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
