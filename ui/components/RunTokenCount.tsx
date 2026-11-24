import type { JobInstance } from '@/lib/api';
import { formatEstimatedTokens, formatRecordedTokens, RECORDED_TOKENS_HINT, TOKEN_ESTIMATE_HINT } from '@/lib/tokenCounts';

export function RunTokenCount({ usage, promptChars, showBreakdown = false }: {
  usage?: Pick<JobInstance, 'token_input' | 'token_output' | 'token_total'> | null;
  promptChars?: number;
  showBreakdown?: boolean;
}) {
  const recorded = formatRecordedTokens(usage);
  if (recorded) {
    return (
      <span className="text-slate-300 tabular-nums" title={[recorded.breakdown, RECORDED_TOKENS_HINT].filter(Boolean).join('. ')}>
        {recorded.label} recorded{showBreakdown && recorded.breakdown && ` (${recorded.breakdown})`}
      </span>
    );
  }
  if (promptChars !== undefined) {
    return <span className="text-slate-300 tabular-nums" title={TOKEN_ESTIMATE_HINT}>{formatEstimatedTokens(promptChars)} in prompt</span>;
  }
  return <span className="text-slate-400">Usage unavailable</span>;
}
