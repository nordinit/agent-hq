import type { JobInstance } from '@/lib/api';
import { formatEstimatedTokens, formatRecordedTokens, RECORDED_TOKENS_HINT, TOKEN_ESTIMATE_HINT } from '@/lib/tokenCounts';

export function RunTokenCount({ usage, promptChars, showBreakdown = false }: {
  usage?: Pick<JobInstance, 'token_input' | 'token_output' | 'token_total' | 'token_usage_status' | 'token_usage_reason' | 'token_cached_input'> | null;
  promptChars?: number;
  showBreakdown?: boolean;
}) {
  const recorded = formatRecordedTokens(usage);
  if (recorded) {
    const partial = usage?.token_usage_status === 'partial';
    const cached = usage?.token_cached_input;
    const details = [
      recorded.breakdown,
      cached != null && `${cached.toLocaleString('en-US')} cached input tokens`,
      partial && 'Final runtime usage has not been reported',
      RECORDED_TOKENS_HINT,
    ].filter(Boolean).join('. ');
    return (
      <span className="text-slate-300 tabular-nums" title={details}>
        {recorded.label} {partial ? 'recorded (partial)' : 'recorded'}{showBreakdown && recorded.breakdown && ` (${recorded.breakdown})`}
      </span>
    );
  }
  return (
    <span className="text-slate-400">
      Recorded usage unavailable
      {promptChars !== undefined && (
        <span className="text-slate-300 tabular-nums" title={TOKEN_ESTIMATE_HINT}> · {formatEstimatedTokens(promptChars)} in prompt</span>
      )}
    </span>
  );
}
