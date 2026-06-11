export interface TokenUsage {
  input: number | null;
  output: number | null;
  total: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function parseDirectUsage(source: Record<string, unknown>): TokenUsage | null {
  const input = toFiniteNumber(
    source.input_tokens ?? source.inputTokens ?? source.prompt_tokens ?? source.promptTokens,
  );
  const output = toFiniteNumber(
    source.output_tokens ?? source.outputTokens ?? source.completion_tokens ?? source.completionTokens,
  );
  const explicitTotal = toFiniteNumber(
    source.total_tokens ?? source.totalTokens ?? source.tokens ?? source.tokenCount,
  );

  if (input === null && output === null && explicitTotal === null) return null;

  return {
    input,
    output,
    total: explicitTotal ?? ((input !== null || output !== null) ? (input ?? 0) + (output ?? 0) : null),
  };
}

export function extractTokenUsage(value: unknown, depth = 0): TokenUsage | null {
  if (value === null || value === undefined || depth > 4) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractTokenUsage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  const source = value as Record<string, unknown>;
  const direct = parseDirectUsage(source);
  if (direct) return direct;

  for (const key of ['usage', 'token_usage', 'tokenUsage', 'metrics', 'meta', 'result', 'response', 'data']) {
    if (key in source) {
      const nested = extractTokenUsage(source[key], depth + 1);
      if (nested) return nested;
    }
  }

  for (const nestedValue of Object.values(source)) {
    const nested = extractTokenUsage(nestedValue, depth + 1);
    if (nested) return nested;
  }

  return null;
}

export function normalizeTokenUsage(...sources: Array<unknown>): TokenUsage {
  let input: number | null = null;
  let output: number | null = null;
  let total: number | null = null;

  for (const source of sources) {
    const usage = extractTokenUsage(source);
    if (!usage) continue;
    if (input === null && usage.input !== null) input = usage.input;
    if (output === null && usage.output !== null) output = usage.output;
    if (total === null && usage.total !== null) total = usage.total;
  }

  return {
    input,
    output,
    total: total ?? ((input !== null || output !== null) ? (input ?? 0) + (output ?? 0) : null),
  };
}
