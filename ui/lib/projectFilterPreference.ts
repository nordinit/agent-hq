'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PROJECT_FILTER_STORAGE_KEY = 'agent-hq:last-project-filter';
const ALL_PROJECTS_VALUE = 'all';

type ProjectFilterSource = 'explicit' | 'stored' | 'fallback';

export type ProjectFilterState = {
  projectId: number | null;
  source: ProjectFilterSource;
};

export type ProjectFilterPreferenceOptions = {
  fallbackProjectId?: number | null;
  validProjectIds?: number[];
};

function parseProjectIdValue(value: string | null): number | null | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized || normalized === ALL_PROJECTS_VALUE || normalized === 'none' || normalized === 'null') return null;

  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readExplicitProjectFilter(): ProjectFilterState | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  if (!params.has('project_id')) return null;

  const parsed = parseProjectIdValue(params.get('project_id'));
  return parsed === undefined ? null : { projectId: parsed, source: 'explicit' };
}

function readStoredProjectFilter(): ProjectFilterState | null {
  if (typeof window === 'undefined') return null;

  try {
    const parsed = parseProjectIdValue(window.localStorage.getItem(PROJECT_FILTER_STORAGE_KEY));
    return parsed === undefined ? null : { projectId: parsed, source: 'stored' };
  } catch {
    return null;
  }
}

function writeStoredProjectFilter(projectId: number | null) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(PROJECT_FILTER_STORAGE_KEY, projectId === null ? ALL_PROJECTS_VALUE : String(projectId));
  } catch {
    // A blocked storage write should not break page-level filtering.
  }
}

export function resolveInitialProjectFilter(fallbackProjectId?: number | null): ProjectFilterState {
  return readExplicitProjectFilter()
    ?? readStoredProjectFilter()
    ?? { projectId: fallbackProjectId ?? null, source: 'fallback' };
}

export function useProjectFilterPreference({
  fallbackProjectId,
  validProjectIds,
}: ProjectFilterPreferenceOptions = {}) {
  const initial = useMemo(() => resolveInitialProjectFilter(fallbackProjectId), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [projectId, setProjectIdState] = useState<number | null>(initial.projectId);
  const sourceRef = useRef<ProjectFilterSource>(initial.source);
  const validProjectIdSet = useMemo(() => new Set(validProjectIds ?? []), [validProjectIds]);

  const setProjectId = useCallback((nextProjectId: number | null) => {
    sourceRef.current = 'stored';
    setProjectIdState(nextProjectId);
    writeStoredProjectFilter(nextProjectId);
  }, []);

  useEffect(() => {
    const explicit = readExplicitProjectFilter();
    if (!explicit) return;

    sourceRef.current = explicit.source;
    setProjectIdState(explicit.projectId);
    writeStoredProjectFilter(explicit.projectId);
  }, []);

  useEffect(() => {
    if (sourceRef.current !== 'fallback' || fallbackProjectId === undefined) return;
    const nextProjectId = fallbackProjectId ?? null;
    setProjectIdState(nextProjectId);
    writeStoredProjectFilter(nextProjectId);
  }, [fallbackProjectId]);

  useEffect(() => {
    if (projectId === null || validProjectIdSet.size === 0 || validProjectIdSet.has(projectId)) return;

    const nextProjectId = fallbackProjectId === undefined ? null : fallbackProjectId;
    sourceRef.current = 'stored';
    setProjectIdState(nextProjectId);
    writeStoredProjectFilter(nextProjectId);
  }, [fallbackProjectId, projectId, validProjectIdSet]);

  return [projectId, setProjectId] as const;
}
