export type CodexJsonEvent = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class CodexJsonlDecoder {
  private buffer = '';
  private readonly malformed: string[] = [];

  push(chunk: string): CodexJsonEvent[] {
    this.buffer += chunk;
    const events: CodexJsonEvent[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        const event = this.decode(line);
        if (event) events.push(event);
      }
      newline = this.buffer.indexOf('\n');
    }
    return events;
  }

  flush(): CodexJsonEvent[] {
    const line = this.buffer.trim();
    this.buffer = '';
    if (!line) return [];
    const event = this.decode(line);
    return event ? [event] : [];
  }

  get malformedLines(): readonly string[] {
    return this.malformed;
  }

  private decode(line: string): CodexJsonEvent | null {
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) return value;
    } catch {
      // Recorded below.
    }
    if (this.malformed.length < 20) this.malformed.push(line.slice(0, 500));
    return null;
  }
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export class CodexStreamAccumulator {
  private threadIdValue: string | null = null;
  private turnCompletedValue = false;
  private turnFailedValue = false;
  private usageValue: CodexUsage | null = null;
  private readonly agentMessages: string[] = [];
  private readonly errorsValue: string[] = [];
  private readonly mcpServerSet = new Set<string>();
  private eventCountValue = 0;

  observe(event: CodexJsonEvent): void {
    this.eventCountValue += 1;
    const type = stringValue(event.type);
    if (type === 'thread.started') {
      this.threadIdValue = stringValue(event.thread_id) ?? this.threadIdValue;
      return;
    }

    if (type === 'turn.completed') {
      this.turnCompletedValue = true;
      const usage = isRecord(event.usage) ? event.usage : {};
      this.usageValue = {
        inputTokens: numberValue(usage.input_tokens),
        cachedInputTokens: numberValue(usage.cached_input_tokens),
        outputTokens: numberValue(usage.output_tokens),
      };
      return;
    }

    if (type === 'turn.failed') {
      this.turnFailedValue = true;
      const error = isRecord(event.error) ? event.error : null;
      const message = stringValue(error?.message) ?? stringValue(event.message);
      if (message) this.errorsValue.push(message);
      return;
    }

    if (type === 'error') {
      const message = stringValue(event.message);
      if (message) this.errorsValue.push(message);
      return;
    }

    if (type !== 'item.completed') return;
    const item = isRecord(event.item) ? event.item : null;
    if (!item) return;
    if (item.type === 'agent_message') {
      const text = stringValue(item.text);
      if (text) this.agentMessages.push(text);
    }
    if (item.type === 'mcp_tool_call') {
      const server = stringValue(item.server);
      if (server) this.mcpServerSet.add(server);
    }
  }

  get threadId(): string | null {
    return this.threadIdValue;
  }
  get sawTurnCompleted(): boolean {
    return this.turnCompletedValue;
  }
  get sawTurnFailed(): boolean {
    return this.turnFailedValue;
  }
  get usage(): CodexUsage | null {
    return this.usageValue;
  }
  get finalText(): string {
    return this.agentMessages.at(-1) ?? '';
  }
  get errors(): readonly string[] {
    return this.errorsValue;
  }
  get mcpServersUsed(): string[] {
    return [...this.mcpServerSet];
  }
  get eventCount(): number {
    return this.eventCountValue;
  }
}
