'use client';

import { CheckCircle, X } from 'lucide-react';

type DeleteResult = {
  archived?: boolean;
  hard_deleted?: boolean;
};

export type AgentDeleteNoticeData = {
  title: string;
  message: string;
};

export function buildAgentDeleteNotice(agentName: string, result?: DeleteResult): AgentDeleteNoticeData {
  const name = agentName.trim() || 'Agent';
  return {
    title: 'Agent deleted',
    message: result?.archived
      ? `Deleted "${name}". Historical tasks and runs were preserved.`
      : `Deleted "${name}".`,
  };
}

export function AgentDeleteNotice({
  notice,
  onDismiss,
}: {
  notice: AgentDeleteNoticeData;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-emerald-600/40 bg-emerald-950/50 px-4 py-3 text-sm text-emerald-100">
      <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{notice.title}</p>
        <p className="mt-0.5 text-emerald-200/80">{notice.message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded p-1 text-emerald-200/70 transition-colors hover:bg-emerald-900/40 hover:text-emerald-100"
        aria-label="Dismiss delete confirmation"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
