import type { TaskStatusMeta } from './api';

export function getTaskStatusEmoji(status: Pick<TaskStatusMeta, 'emoji' | 'metadata'> | null | undefined): string {
  const direct = typeof status?.emoji === 'string' ? status.emoji.trim() : '';
  if (direct) return direct;
  const metadataEmoji = status?.metadata && typeof status.metadata.emoji === 'string'
    ? status.metadata.emoji.trim()
    : '';
  return metadataEmoji;
}

export function normalizeTaskStatusEmojiInput(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
