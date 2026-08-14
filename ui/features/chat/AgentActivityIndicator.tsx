'use client';

import { memo } from 'react';
import { Bot } from 'lucide-react';
import type { RunActivity } from '@/lib/api';
import { activityLabel, isActivityStalled, isActivityVisible } from '@/lib/agentActivity';

/**
 * Typing indicator for an open agent turn.
 *
 * Deliberately says what the agent is doing ("Using Bash") rather than showing
 * an anonymous spinner: the runtimes already report tool calls, thinking, and
 * text as distinct transcript events, and a long tool call is exactly when a
 * bare spinner reads as a hang. The label arrives pre-normalized from the API,
 * so nothing here branches on runtime.
 */

export { isActivityVisible };

const AnimatedDots = memo(function AnimatedDots({ muted }: { muted: boolean }) {
  const color = muted ? 'bg-slate-500' : 'bg-amber-400';
  return (
    // aria-hidden: the label beside this already carries the meaning, so a
    // screen reader should not also announce three decorative dots.
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {[0, 150, 300].map(delay => (
        <span
          key={delay}
          className={`inline-block w-1.5 h-1.5 rounded-full ${color} animate-bounce`}
          style={{ animationDelay: `${delay}ms`, animationDuration: '1s' }}
        />
      ))}
    </span>
  );
});

export const AgentActivityIndicator = memo(function AgentActivityIndicator({
  activity,
}: {
  activity: RunActivity | null;
}) {
  if (!isActivityVisible(activity) || !activity) return null;

  const stalled = isActivityStalled(activity);

  return (
    <div className="flex justify-start mb-3" data-testid="agent-activity-indicator">
      <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mr-2 mt-0.5">
        <Bot className="w-3.5 h-3.5 text-amber-400" />
      </div>
      <div
        className="rounded-2xl px-4 py-2.5 text-sm bg-slate-700/60 border border-slate-600/50 rounded-tl-sm flex items-center gap-2"
        // polite: the label changes on every tool call, and assertive would
        // interrupt the reader continuously through a long run.
        role="status"
        aria-live="polite"
      >
        <AnimatedDots muted={stalled} />
        <span className={stalled ? 'text-slate-400 italic' : 'text-slate-300'}>
          {activityLabel(activity)}
        </span>
      </div>
    </div>
  );
});
