'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A textarea that grows with its content between a minimum and maximum number of rows, then
 * scrolls.
 *
 * The height is measured rather than computed from a line count: a description wraps, so
 * counting newlines under-reports how tall the text actually is. Resetting to `auto` before
 * reading scrollHeight is what makes it shrink again when text is deleted — scrollHeight never
 * reports less than the current height, so without the reset the box would only ever grow.
 *
 * Sizing runs in useLayoutEffect so the first paint is already the right height; doing it in
 * useEffect shows one frame at the minimum and then jumps.
 */
export function AutoGrowTextarea({
  value,
  onChange,
  minRows = 4,
  maxRows = 10,
  className = '',
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  minRows?: number;
  maxRows?: number;
  className?: string;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows' | 'className'>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // Read the real line height rather than assuming one: these boxes inherit text-sm from a
    // parent, and a hardcoded guess would clip the last row at some font sizes.
    const styles = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight) || Number.parseFloat(styles.fontSize) * 1.5;
    const chrome = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
      + Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);

    const min = lineHeight * minRows + chrome;
    const max = lineHeight * maxRows + chrome;

    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${next}px`;
    // Only scroll once the content has passed the cap, so a short description shows no scrollbar.
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [minRows, maxRows]);

  // Re-runs on `value` so the box is already the right size when a modal opens on an existing
  // description, not just while someone is typing into it.
  useLayoutEffect(resize, [resize, value]);

  return (
    <textarea
      {...rest}
      ref={ref}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`resize-none ${className}`}
    />
  );
}
