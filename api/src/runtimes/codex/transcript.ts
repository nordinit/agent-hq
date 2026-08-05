import { renderToolPayload, type RuntimeTranscriptEvent } from '../transcript/events';
import type { CodexJsonEvent } from './streamJson';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toolName(item: Record<string, unknown>): string {
  if (item.type === 'mcp_tool_call') {
    return [text(item.server), text(item.tool)].filter(Boolean).join('/') || 'mcp';
  }
  if (item.type === 'web_search') return 'web_search';
  return 'shell';
}

function toolPayload(item: Record<string, unknown>): unknown {
  if (item.type === 'mcp_tool_call') return item.result ?? item.error ?? null;
  if (item.type === 'web_search') return item.query ?? null;
  return item.aggregated_output ?? item.output ?? null;
}

export function decodeCodexJsonEvent(event: CodexJsonEvent): RuntimeTranscriptEvent[] {
  const type = text(event.type);
  if (type === 'error' || type === 'turn.failed') {
    const nested = isRecord(event.error) ? event.error : null;
    const message = text(nested?.message) || text(event.message) || 'Codex turn failed';
    return [{ kind: 'system', role: 'system', content: message, isError: true }];
  }

  if (type !== 'item.started' && type !== 'item.completed') return [];
  const item = isRecord(event.item) ? event.item : null;
  if (!item) return [];
  const itemType = text(item.type);
  const itemId = text(item.id) || undefined;

  if (type === 'item.completed' && itemType === 'agent_message') {
    const value = text(item.text);
    return value ? [{ kind: 'text', role: 'assistant', content: value }] : [];
  }
  if (type === 'item.completed' && itemType === 'reasoning') {
    const value = text(item.text);
    return value ? [{ kind: 'thought', role: 'assistant', content: value }] : [];
  }

  const isTool = ['command_execution', 'mcp_tool_call', 'web_search'].includes(itemType);
  if (!isTool) return [];
  const name = toolName(item);
  if (type === 'item.started') {
    return [{
      kind: 'tool_call',
      role: 'assistant',
      content: name,
      toolName: name,
      toolUseId: itemId,
      meta: {
        tool_name: name,
        command: item.command ?? null,
        arguments: item.arguments ?? null,
        query: item.query ?? null,
      },
    }];
  }
  return [{
    kind: 'tool_result',
    role: 'tool',
    content: renderToolPayload(toolPayload(item)),
    toolName: name,
    toolUseId: itemId,
    isError: item.status === 'failed' || item.error != null,
    meta: {
      tool_name: name,
      status: item.status ?? null,
      exit_code: item.exit_code ?? null,
      error: item.error ?? null,
    },
  }];
}

export function codexPromptTranscriptEvent(prompt: string): RuntimeTranscriptEvent {
  return { kind: 'text', role: 'user', content: prompt };
}
