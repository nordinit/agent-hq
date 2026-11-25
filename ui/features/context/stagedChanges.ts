'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ContextChange } from '@/lib/api';

/** One staged edit. `key` names the source it edits, so a second edit replaces the first. */
export interface StagedChange {
  key: string;
  label: string;
  change: ContextChange;
  /** Set when publish found the source changed underneath this edit. */
  conflictHash?: string;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

export function changeTarget(change: ContextChange): string {
  switch (change.kind) {
    case 'job_instructions':
    case 'agent_skills':
      return `${change.kind}:agent:${change.agent_id}`;
    case 'mcp_allowlist':
      return `${change.kind}:agent:${change.agent_id}:server:${change.mcp_server_id}`;
    case 'workflow_goal':
      return `${change.kind}:workflow:${change.workflow_id}`;
    case 'project_context':
      return `${change.kind}:project:${change.project_id}`;
    case 'task_description':
      return `${change.kind}:task:${change.task_id}`;
    case 'series_template':
      return `${change.kind}:series:${change.series_id}`;
  }
}

export function useStagedChanges() {
  const [staged, setStaged] = useState<Map<string, StagedChange>>(new Map());

  /**
   * Stage `change`, or drop the staged edit when the value is back to what was loaded. Text
   * compares exactly; lists compare as sets.
   */
  const stage = useCallback((label: string, change: ContextChange, original: string | string[]) => {
    const key = changeTarget(change);
    setStaged((previous) => {
      const next = new Map(previous);
      const unchanged = Array.isArray(original)
        ? Array.isArray(change.value) && sameList(change.value, original)
        : change.value === original;
      if (unchanged) next.delete(key);
      else next.set(key, { key, label, change });
      return next;
    });
  }, []);

  const discard = useCallback((key: string) => {
    setStaged((previous) => {
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
  }, []);

  const discardAll = useCallback(() => setStaged(new Map()), []);

  const markConflicts = useCallback((conflicts: Array<{ target: string; currentHash: string }>) => {
    setStaged((previous) => {
      const next = new Map(previous);
      for (const conflict of conflicts) {
        const entry = next.get(conflict.target);
        if (entry) next.set(conflict.target, { ...entry, conflictHash: conflict.currentHash });
      }
      return next;
    });
  }, []);

  /** Keep this edit and publish it over the newer version someone else saved. */
  const overwrite = useCallback((key: string) => {
    setStaged((previous) => {
      const entry = previous.get(key);
      if (!entry?.conflictHash) return previous;
      const next = new Map(previous);
      next.set(key, { ...entry, change: { ...entry.change, base_hash: entry.conflictHash }, conflictHash: undefined });
      return next;
    });
  }, []);

  const list = useMemo(() => [...staged.values()], [staged]);

  return {
    staged,
    list,
    stage,
    discard,
    discardAll,
    markConflicts,
    overwrite,
    /** The staged value for a source, if any. */
    valueFor: <T extends string | string[]>(key: string): T | undefined =>
      staged.get(key)?.change.value as T | undefined,
  };
}

export type StagedChanges = ReturnType<typeof useStagedChanges>;
