import type { MaterializationResult } from '../runtimes/skillMaterialization';
import { createNotificationRecord } from './notifications';
import { getActiveTenantId } from './tenantContext';
import { type Db } from "../db/adapter/types";

export interface SkillMaterializationNotificationContext {
  runtimeType: string;
  agentId: number | null;
  agentName: string | null;
  instanceId: number | null;
  taskId?: number | null;
  tenantId?: number | null;
  /** Skill names that were requested for materialization. */
  requestedSkillNames: string[];
}

/**
 * Records an Agent HQ notification when dispatch-time skill materialization
 * failed or silently dropped skills. The adapter reports unresolved skills as
 * `skipped / source not found` (and per-skill copy failures as `error`) while
 * still returning ok=true, so operators never see the degradation unless we
 * surface it explicitly.
 *
 * Returns true when a notification was recorded.
 */
export async function recordSkillMaterializationIssues(
  db: Db,
  result: MaterializationResult,
  context: SkillMaterializationNotificationContext,
): Promise<boolean> {
  const unresolved = result.details
    .filter((d) => d.action === 'skipped' && d.reason === 'source not found')
    .map((d) => d.skill);
  const errored = result.details
    .filter((d) => d.action === 'error')
    .map((d) => d.skill);
  const fatal = !result.ok;
  // Total silent skip: skills were requested but the adapter never attempted any
  // (e.g. no skillsBasePath and no DB handle — only a warning is emitted).
  const totalSkip = context.requestedSkillNames.length > 0
    && result.count === 0
    && result.details.length === 0
    && (fatal || result.warnings.length > 0);

  if (!fatal && unresolved.length === 0 && errored.length === 0 && !totalSkip) return false;

  try {
    const agentLabel = context.agentName || (context.agentId ? `agent #${context.agentId}` : 'unknown agent');
    const problems: string[] = [];
    if (fatal && result.error) problems.push(`Error: ${result.error}`);
    if (unresolved.length > 0) problems.push(`Unresolved (no source found): ${unresolved.join(', ')}`);
    if (errored.length > 0) problems.push(`Failed to materialize: ${errored.join(', ')}`);
    if (totalSkip) problems.push(`Requested skills were skipped entirely: ${context.requestedSkillNames.join(', ')}`);
    if (result.warnings.length > 0) problems.push(`Warnings: ${result.warnings.join(' | ')}`);

    const affectedCount = fatal || totalSkip
      ? context.requestedSkillNames.length
      : unresolved.length + errored.length;

    const tenantId = Number(context.tenantId);
    await createNotificationRecord(db, {
            tenantId: Number.isInteger(tenantId) && tenantId > 0 ? tenantId : await getActiveTenantId(db),
            type: 'skill_materialization_failure',
            title: `🧩 Skill materialization issue for ${agentLabel}`,
            body: [
              `${affectedCount} of ${context.requestedSkillNames.length} assigned skill(s) did not materialize for ${agentLabel} (${context.runtimeType}).`,
              ...problems,
              context.instanceId ? `Instance #${context.instanceId}${context.taskId ? ` · Task #${context.taskId}` : ''}` : null,
              'The agent was dispatched without the missing skill content.',
            ].filter((line): line is string => Boolean(line)).join('\n'),
            source: 'dispatcher',
            outlet: 'agent_hq',
            metadata: {
              runtimeType: context.runtimeType,
              agentId: context.agentId,
              agentName: context.agentName,
              instanceId: context.instanceId,
              taskId: context.taskId ?? null,
              requestedSkills: context.requestedSkillNames,
              unresolvedSkills: unresolved,
              erroredSkills: errored,
              warnings: result.warnings,
              error: result.error ?? null,
            },
          });
    return true;
  } catch (err) {
    console.error('[dispatcher] Failed to record skill materialization notification:', err);
    return false;
  }
}
