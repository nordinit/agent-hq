import type { Request } from 'express';
import { getMcpIdentityFromRequest } from '../../lib/mcpApiAuth';
import { HUMAN_ACTORS } from '../../lib/taskRelease';
import { OPERATOR_ACTOR } from '../../lib/operatorActor';

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
  if (lowered === 'operator' || lowered === 'manual' || lowered === 'atlas') return OPERATOR_ACTOR;
  if (lowered === 'user' || lowered === 'human') return 'user';
  return trimmed;
}

function isExplicitManualOverrideAuthority(value: string | undefined): boolean {
  const normalized = normalizeAuthority(value);
  if (!normalized) return false;
  if (normalized === OPERATOR_ACTOR) return true;
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
