/** Operator-only project allowlist for background scheduling and dispatch. */
export function automationProjectIds(env: NodeJS.ProcessEnv = process.env): number[] | null {
  const raw = env.AGENT_HQ_AUTOMATION_PROJECT_IDS;
  if (raw === undefined) return null;
  const parts = raw.split(',').map(value => value.trim());
  if (parts.length === 0 || parts.some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw new Error('AGENT_HQ_AUTOMATION_PROJECT_IDS must contain positive integer project IDs separated by commas.');
  }
  return [...new Set(parts.map(Number))];
}
