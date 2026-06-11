export interface DeepLinkJobInstance {
  id: number;
  agent_id: number;
  created_at: string;
}

export interface DeepLinkChatSession {
  instance_id: number | null;
  session_key?: string;
  agent_id?: number;
  agent_name?: string | null;
  project_id?: number | null;
  started_at?: string;
  last_activity?: string;
}

export interface DeepLinkFallbackJobInstance extends DeepLinkJobInstance {
  template_id: number;
  project_id?: number | null;
  task_id?: number | null;
  task_title?: string | null;
  task_status?: string | null;
  job_title?: string;
  agent_name?: string;
  agent_session_key?: string;
  status: 'queued' | 'dispatched' | 'running' | 'done' | 'failed';
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  payload_sent: string | null;
  response: string | null;
  error: string | null;
  session_key: string | null;
}

export function mergeDeepLinkedInstance<T extends DeepLinkJobInstance>(
  instances: T[],
  deepLinkedInstance: T | null,
  selectedAgentId: number,
): T[] {
  if (!deepLinkedInstance || deepLinkedInstance.agent_id !== selectedAgentId) return instances;
  if (instances.some(instance => instance.id === deepLinkedInstance.id)) return instances;
  return [deepLinkedInstance, ...instances];
}

export function sortInstancesByCreatedAtDesc<T extends DeepLinkJobInstance>(instances: T[]): T[] {
  return [...instances].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export function shouldPreserveSelectedDeepLink(
  selectedInstanceId: number | null,
  deepLinkInstanceId: number | null,
): boolean {
  return selectedInstanceId !== null && selectedInstanceId === deepLinkInstanceId;
}

export function shouldAutoOpenDefaultChat(
  isMobileViewport: boolean,
  hasExplicitChatTarget: boolean,
): boolean {
  return hasExplicitChatTarget || !isMobileViewport;
}

export function mergeTargetChatSessions<T extends DeepLinkChatSession>(
  sessions: T[],
  targetSessions: T[],
): T[] {
  const existingInstanceIds = new Set(
    sessions
      .map(session => session.instance_id)
      .filter((id): id is number => typeof id === 'number'),
  );
  const missingTargets = targetSessions.filter(session => (
    typeof session.instance_id !== 'number' || !existingInstanceIds.has(session.instance_id)
  ));
  return missingTargets.length === 0 ? sessions : [...missingTargets, ...sessions];
}

export function buildFallbackInstanceFromChatSession<T extends DeepLinkChatSession>(
  session: T | null | undefined,
): DeepLinkFallbackJobInstance | null {
  if (
    !session
    || typeof session.instance_id !== 'number'
    || typeof session.agent_id !== 'number'
    || typeof session.session_key !== 'string'
  ) return null;
  const createdAt = session.started_at || session.last_activity || new Date(0).toISOString();
  return {
    id: session.instance_id,
    template_id: 0,
    agent_id: session.agent_id,
    project_id: session.project_id,
    task_id: null,
    task_title: null,
    task_status: null,
    job_title: `Run #${session.instance_id}`,
    agent_name: session.agent_name ?? undefined,
    agent_session_key: session.session_key,
    status: 'dispatched',
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    payload_sent: null,
    response: null,
    error: null,
    created_at: createdAt,
    session_key: session.session_key,
  };
}
