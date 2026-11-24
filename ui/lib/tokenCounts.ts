import type { ChatMessage, JobInstance } from './api/types';

// Anthropic uses 3.5 characters per token for a rough estimate in its content moderation guide.
export const TOKEN_ESTIMATE_HINT = 'Rough Claude text estimate using 3.5 characters per token. Actual counts vary by model and content.';
export const RECORDED_TOKENS_HINT = 'Usage recorded by the run’s runtime. Token counts and cache accounting vary by model and runtime.';

export function formatEstimatedTokens(chars: number): string {
  return `≈${Math.ceil(chars / 3.5).toLocaleString('en-US')} tokens`;
}

export function formatRecordedTokens(usage?: Pick<JobInstance, 'token_input' | 'token_output' | 'token_total'> | null) {
  const input = usage?.token_input;
  const output = usage?.token_output;
  const total = usage?.token_total ?? (input != null && output != null ? input + output : null);
  const breakdown = [
    input != null ? `${input.toLocaleString('en-US')} in` : null,
    output != null ? `${output.toLocaleString('en-US')} out` : null,
  ].filter(Boolean).join(' / ');

  if (total == null) {
    const partial = input ?? output;
    return partial == null ? null : {
      label: `${partial.toLocaleString('en-US')} ${input != null ? 'input' : 'output'} tokens`,
      breakdown: '',
    };
  }
  return {
    label: `${total.toLocaleString('en-US')} tokens`,
    breakdown,
  };
}

export function chatTextSize(messages: ChatMessage[]): number {
  return messages.reduce((size, message) => {
    if (message.role === 'system' || (message.event_type && message.event_type !== 'text')) return size;
    return size + message.content.length;
  }, 0);
}
