export interface OpenClawStructuredEvent {
  event_type: 'text' | 'thought' | 'tool_call' | 'tool_result';
  content: string;
  event_meta: Record<string, unknown>;
}

interface GatewayContentBlock {
  type?: string;
  kind?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_name?: string;
  input?: unknown;
  arguments?: unknown;
  args?: unknown;
  tool_use_id?: string;
  tool_call_id?: string;
  content?: unknown;
  output?: unknown;
  result?: unknown;
  thinking?: string;
  details?: unknown;
  is_error?: boolean;
  partialJson?: unknown;
}

function normalizeRoleToken(role: unknown): string {
  if (typeof role !== 'string') return '';
  return role.replace(/[_\-\s]+/g, '').trim().toLowerCase();
}

function normalizeBlockType(type: unknown): string {
  if (typeof type !== 'string') return '';
  return type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[_\-\s]+/g, '_')
    .toLowerCase();
}

function getTextFromBlock(block: GatewayContentBlock): string {
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  return '';
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (!item || typeof item !== 'object') return '';
        return getTextFromBlock(item as GatewayContentBlock);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractPlainTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      if (!item || typeof item !== 'object') return '';
      const block = item as GatewayContentBlock;
      return normalizeBlockType(block.type ?? block.kind) === 'text'
        ? getTextFromBlock(block)
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function unwrapGatewayMessage(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const nested = record.message;
  if (nested && typeof nested === 'object') {
    return nested as Record<string, unknown>;
  }
  return record;
}

export function extractTextFromGatewayMessage(raw: unknown): string {
  const msg = unwrapGatewayMessage(raw);
  if (!msg) return '';
  const contentText = extractPlainTextContent(msg.content);
  if (contentText) return contentText;
  if (typeof msg.content === 'string') return msg.content;
  if (typeof msg.text === 'string') return msg.text;
  return '';
}

function buildToolCallEvent(
  toolName: unknown,
  args: unknown,
  id: unknown,
  partialJson?: unknown,
): OpenClawStructuredEvent {
  const eventMeta: Record<string, unknown> = {
    name: typeof toolName === 'string' && toolName.trim() ? toolName : 'unknown',
    args: args ?? {},
    id: typeof id === 'string' && id.trim() ? id : null,
  };
  if (typeof partialJson === 'string' && partialJson.trim()) {
    eventMeta.partial_json = partialJson;
  }
  return {
    event_type: 'tool_call',
    content: eventMeta.name as string,
    event_meta: eventMeta,
  };
}

function buildToolResultEvent(params: {
  output: unknown;
  toolUseId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  details?: unknown;
}): OpenClawStructuredEvent {
  const output = stringifyOutput(params.output);
  const eventMeta: Record<string, unknown> = {
    tool_use_id: typeof params.toolUseId === 'string' && params.toolUseId.trim() ? params.toolUseId : null,
    output,
  };
  if (typeof params.toolName === 'string' && params.toolName.trim()) {
    eventMeta.tool_name = params.toolName;
  }
  if (params.isError === true) {
    eventMeta.is_error = true;
  }
  if (params.details && typeof params.details === 'object') {
    eventMeta.details = params.details;
  }
  return {
    event_type: 'tool_result',
    content: output.slice(0, 4000),
    event_meta: eventMeta,
  };
}

export function extractGatewayStructuredEvents(raw: unknown): OpenClawStructuredEvent[] {
  const msg = unwrapGatewayMessage(raw);
  if (!msg) {
    return [{ event_type: 'text', content: '', event_meta: {} }];
  }

  const normalizedRole = normalizeRoleToken(msg.role);
  const contentRaw = msg.content;

  if (normalizedRole === 'toolresult') {
    return [buildToolResultEvent({
      output: (msg.details as Record<string, unknown> | undefined)?.aggregated ?? contentRaw ?? msg.output ?? msg.result ?? msg.text ?? '',
      toolUseId: msg.toolCallId ?? msg.tool_use_id ?? msg.tool_call_id ?? msg.id,
      toolName: msg.toolName ?? msg.tool_name ?? msg.name,
      isError: msg.isError ?? msg.is_error,
      details: msg.details,
    })];
  }

  if (normalizedRole === 'toolcall' || normalizedRole === 'tooluse') {
    return [buildToolCallEvent(
      msg.toolName ?? msg.tool_name ?? msg.name,
      msg.arguments ?? msg.input ?? msg.args ?? {},
      msg.toolCallId ?? msg.id,
      msg.partialJson,
    )];
  }

  if (Array.isArray(contentRaw)) {
    const events: OpenClawStructuredEvent[] = [];

    for (const item of contentRaw) {
      if (!item || typeof item !== 'object') continue;
      const block = item as GatewayContentBlock;
      const blockType = normalizeBlockType(block.type ?? block.kind);

      if (blockType === 'text') {
        const text = getTextFromBlock(block);
        if (text) {
          events.push({ event_type: 'text', content: text, event_meta: {} });
        }
        continue;
      }

      if (blockType === 'thinking' || blockType === 'thought') {
        const thought = typeof block.thinking === 'string' ? block.thinking : getTextFromBlock(block);
        events.push({ event_type: 'thought', content: thought, event_meta: {} });
        continue;
      }

      if (blockType === 'tool_call' || blockType === 'tool_use') {
        events.push(buildToolCallEvent(
          block.name ?? block.tool_name,
          block.input ?? block.arguments ?? block.args ?? {},
          block.id,
          block.partialJson,
        ));
        continue;
      }

      if (blockType === 'tool_result') {
        events.push(buildToolResultEvent({
          output: block.output ?? block.result ?? block.content ?? block.text ?? '',
          toolUseId: block.tool_use_id ?? block.tool_call_id ?? block.id,
          toolName: block.name ?? block.tool_name,
          isError: block.is_error,
          details: block.details,
        }));
      }
    }

    if (events.length > 0) return events;
  }

  const topLevelToolCall = msg.tool_call;
  if (topLevelToolCall && typeof topLevelToolCall === 'object') {
    const toolCall = topLevelToolCall as Record<string, unknown>;
    return [buildToolCallEvent(
      toolCall.name ?? toolCall.tool_name,
      toolCall.arguments ?? toolCall.input ?? toolCall.args ?? {},
      toolCall.id,
      toolCall.partialJson,
    )];
  }

  const topLevelToolResult = msg.tool_result;
  if (topLevelToolResult && typeof topLevelToolResult === 'object') {
    const toolResult = topLevelToolResult as Record<string, unknown>;
    return [buildToolResultEvent({
      output: toolResult.output ?? toolResult.result ?? toolResult.content ?? '',
      toolUseId: toolResult.tool_use_id ?? toolResult.tool_call_id ?? toolResult.id,
      toolName: toolResult.tool_name ?? toolResult.name,
      isError: toolResult.is_error,
      details: toolResult.details,
    })];
  }

  return [{
    event_type: 'text',
    content: extractTextFromGatewayMessage(msg),
    event_meta: {},
  }];
}
