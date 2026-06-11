'use client';

import { useEffect, useRef } from 'react';

interface LiveRefreshOptions {
  enabled?: boolean;
  intervalMs?: number;
  hiddenIntervalMs?: number;
  refreshOnFocus?: boolean;
  refreshOnVisible?: boolean;
}

export function useLiveRefresh(
  refresh: () => Promise<void> | void,
  {
    enabled = true,
    intervalMs = 10000,
    hiddenIntervalMs = 30000,
    refreshOnFocus = true,
    refreshOnVisible = true,
  }: LiveRefreshOptions = {},
) {
  const refreshRef = useRef(refresh);
  const runningRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const clearScheduled = () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const runRefresh = async () => {
      if (cancelled || runningRef.current) return;
      runningRef.current = true;
      try {
        await refreshRef.current();
      } finally {
        runningRef.current = false;
      }
    };

    const scheduleNext = () => {
      if (cancelled) return;
      clearScheduled();
      const nextDelay = document.visibilityState === 'visible' ? intervalMs : hiddenIntervalMs;
      timeoutRef.current = window.setTimeout(async () => {
        await runRefresh();
        scheduleNext();
      }, nextDelay);
    };

    const handleFocus = () => {
      if (refreshOnFocus) {
        void runRefresh();
      }
      scheduleNext();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && refreshOnVisible) {
        void runRefresh();
      }
      scheduleNext();
    };

    scheduleNext();
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      clearScheduled();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, hiddenIntervalMs, intervalMs, refreshOnFocus, refreshOnVisible]);
}
