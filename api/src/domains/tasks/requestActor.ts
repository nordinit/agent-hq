import type { Request } from 'express';
import { getMcpIdentityFromRequest } from '../../lib/mcpApiAuth';
import { HUMAN_ACTORS } from '../../lib/taskRelease';

export interface ResolvedTaskRequestActor {
  changedBy: string;
  authorityBy: string;
  source: 'mcp' | 'request';
  isManualOverride: boolean;
}

function normalizeAuthority(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'atlas' || lowered === 'operator' || lowered === 'manual') return 'Atlas';
  if (lowered === 'user' || lowered === 'human') return 'user';
  return trimmed;
}

function isExplicitManualOverrideAuthority(value: string | undefined): boolean {
  const normalized = normalizeAuthority(value);
  if (!normalized) return false;
  if (normalized === 'Atlas') return true;
  if (HUMAN_ACTORS.has(normalized)) return true;
  return false;
}

export function resolveRequestActor(
  req: Request,
  fallbackChangedBy: string,
  fallbackAuthorityBy?: string,
): ResolvedTaskRequestActor {
  const mcpIdentity = getMcpIdentityFromRequest(req);
  if (mcpIdentity) {
    return {
      changedBy: mcpIdentity.auditActor,
      authorityBy: mcpIdentity.authorityActor,
      source: 'mcp',
      isManualOverride: true,
    };
  }

  const authorityBy = normalizeAuthority(fallbackAuthorityBy) ?? fallbackChangedBy;
  return {
    changedBy: fallbackChangedBy,
    authorityBy,
    source: 'request',
    isManualOverride: isExplicitManualOverrideAuthority(authorityBy),
  };
}
