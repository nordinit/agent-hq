import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startRunInstance } from './callbacks';
import { buildGatewayRunSessionKey, parseHookSessionKey, parseRunSessionKey } from '../../lib/sessionKeys';
import { type Db } from "../../db/adapter/types";

const CRON_RUNS_DIR = path.join(os.homedir(), '.openclaw', 'cron', 'runs');

export async function resolveInstanceSessionKey(
  db: Db,
  instanceId: number,
): Promise<Record<string, unknown>> {
  const instance = await db.get('SELECT * FROM job_instances WHERE id = ?', instanceId) as Record<string, unknown> | undefined;
  if (!instance) {
    const error = new Error('Instance not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  const agentId = instance.agent_id as number | null;
  const storedKey = instance.session_key as string | null;

  if (storedKey && storedKey.startsWith('agent:') && parseHookSessionKey(storedKey)) {
    return { sessionKey: storedKey, source: 'instance', agentId };
  }

  const hook = parseHookSessionKey(storedKey);
  if (hook) {
    const agentRow = await db.get(`
      SELECT a.session_key as agent_session_key, a.openclaw_agent_id, a.name
      FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
    `, instanceId) as {
      agent_session_key: string | null;
      openclaw_agent_id: string | null;
      name: string | null;
    } | undefined;

    const fullKey = buildGatewayRunSessionKey({
      session_key: agentRow?.agent_session_key ?? null,
      openclaw_agent_id: agentRow?.openclaw_agent_id ?? null,
      name: agentRow?.name ?? null,
    }, hook.shortKey);
    if (fullKey) {
      return { sessionKey: fullKey, source: 'instance-reconstructed', agentId };
    }
    return { sessionKey: storedKey, source: 'instance', agentId };
  }

  if (storedKey && parseRunSessionKey(storedKey)) {
    return { sessionKey: storedKey, source: 'instance', agentId };
  }

  const responseStr = instance.response as string | null;
  let cronJobId: string | null = null;
  if (responseStr) {
    try {
      const parsed = JSON.parse(responseStr) as { jobId?: string };
      cronJobId = parsed.jobId ?? null;
    } catch {
      // ignore malformed response JSON
    }
  }

  if (!cronJobId && storedKey) {
    const match = storedKey.match(/cron:([a-f0-9-]+)/);
    if (match) cronJobId = match[1];
  }

  if (!cronJobId) {
    return { sessionKey: storedKey, source: 'fallback', agentId };
  }

  const runFile = path.join(CRON_RUNS_DIR, `${cronJobId}.jsonl`);
  if (!fs.existsSync(runFile)) {
    return { sessionKey: storedKey, source: 'fallback', note: 'cron run file not found', cronJobId, agentId };
  }

  const content = fs.readFileSync(runFile, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { sessionKey?: string };
      if (event.sessionKey) {
        await startRunInstance(db, instanceId, event.sessionKey);
        return { sessionKey: event.sessionKey, source: 'cron-run', cronJobId, agentId };
      }
    } catch {
      // ignore malformed JSONL entries
    }
  }

  return { sessionKey: storedKey, source: 'fallback', note: 'no sessionKey in cron run', cronJobId, agentId };
}
