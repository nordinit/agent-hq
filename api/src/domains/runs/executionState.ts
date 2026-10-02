// Internal run states are an execution protocol, independent of configured task statuses.
export const LIVE_INSTANCE_STATUSES = ['queued', 'dispatched', 'running'] as const;
export const TERMINAL_INSTANCE_STATUSES = ['done', 'failed', 'cancelled'] as const;

export function isLiveInstanceStatus(status: string | null | undefined): boolean {
  return LIVE_INSTANCE_STATUSES.some(value => value === status);
}

export function isTerminalInstanceStatus(status: string | null | undefined): boolean {
  return TERMINAL_INSTANCE_STATUSES.some(value => value === status);
}
