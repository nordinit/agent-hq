'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { ColumnHeaderTooltip } from '@/components/ui/table-column-help';

export type ColumnFilterOption = { value: string; label: string };

export function matchesColumnFilter(selected: string[], value: string): boolean {
  return selected.length === 0 || selected.includes(value);
}

export function uniqueColumnOptions(options: ColumnFilterOption[]): ColumnFilterOption[] {
  const seen = new Map<string, string>();
  for (const option of options) {
    if (!seen.has(option.value)) seen.set(option.value, option.label);
  }
  return Array.from(seen, ([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MENU_MAX_HEIGHT = 288;

/**
 * Places the menu in viewport coordinates next to its trigger. The menu is portaled to <body> so
 * table wrappers with overflow clipping (e.g. a short, filtered table) can never cut it off.
 */
function computeMenuStyle(trigger: DOMRect, align: 'left' | 'right' | 'center'): CSSProperties {
  const spaceBelow = window.innerHeight - trigger.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const spaceAbove = trigger.top - MENU_GAP - VIEWPORT_MARGIN;
  const openUp = spaceBelow < Math.min(MENU_MAX_HEIGHT, 200) && spaceAbove > spaceBelow;
  const style: CSSProperties = {
    position: 'fixed',
    maxHeight: Math.max(120, Math.min(MENU_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow)),
  };
  if (openUp) style.bottom = window.innerHeight - trigger.top + MENU_GAP;
  else style.top = trigger.bottom + MENU_GAP;
  if (align === 'right') {
    style.right = Math.max(VIEWPORT_MARGIN, window.innerWidth - trigger.right);
  } else if (align === 'center') {
    style.left = trigger.left + trigger.width / 2;
    style.transform = 'translateX(-50%)';
  } else {
    style.left = Math.max(VIEWPORT_MARGIN, trigger.left);
  }
  return style;
}

export function TableColumnFilter({
  label,
  description,
  selected,
  options,
  onChange,
  align = 'left',
}: {
  label: string;
  description?: string;
  selected: string[];
  options: ColumnFilterOption[];
  onChange: (values: string[]) => void;
  align?: 'left' | 'right' | 'center';
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger) setMenuStyle(computeMenuStyle(trigger.getBoundingClientRect(), align));
  }, [align]);

  useLayoutEffect(() => {
    if (open) updatePosition();
    else setMenuStyle(null);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    // Capture phase so scrolling any ancestor (table wrapper, page, modal) keeps the menu attached.
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);
  const normalizedOptions = uniqueColumnOptions(options);
  const selectedSet = new Set(selected);
  const toggle = (value: string) => {
    onChange(selectedSet.has(value)
      ? selected.filter(item => item !== value)
      : [...selected, value]);
  };
  return (
    <div className={`relative inline-flex ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        aria-label={description ? `${label}: ${description}` : label}
        className={`group relative inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold uppercase tracking-wider transition-colors ${selected.length > 0 ? 'text-amber-300' : 'text-slate-400 hover:text-slate-200'}`}
      >
        <span className="truncate">{label}</span>
        {selected.length > 0 && (
          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] leading-none text-amber-300">{selected.length}</span>
        )}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        {description && !open && <ColumnHeaderTooltip description={description} align={align} />}
      </button>
      {open && menuStyle && createPortal(
        <div
          ref={menuRef}
          style={menuStyle}
          className="z-[65] flex min-w-[190px] flex-col rounded-lg border border-slate-700 bg-slate-950 p-2 text-left normal-case tracking-normal shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Filter</span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="text-xs text-amber-300 hover:text-amber-200">Clear</button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {normalizedOptions.length === 0 ? (
              <p className="px-1 py-2 text-xs text-slate-500">No values</p>
            ) : normalizedOptions.map(option => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                <input
                  type="checkbox"
                  checked={selectedSet.has(option.value)}
                  onChange={() => toggle(option.value)}
                  className="h-3 w-3 rounded border-slate-600 bg-slate-900 text-amber-500"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
