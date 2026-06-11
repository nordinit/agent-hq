'use client';

type ColumnHeaderTooltipProps = {
  description: string;
  align?: 'left' | 'right' | 'center';
};

export function ColumnHeaderTooltip({ description, align = 'left' }: ColumnHeaderTooltipProps) {
  const alignmentClass = align === 'right'
    ? 'right-0'
    : align === 'center'
      ? 'left-1/2 -translate-x-1/2'
      : 'left-0';

  return (
    <span
      role="tooltip"
      className={`pointer-events-none absolute top-7 z-40 hidden w-64 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-slate-300 shadow-xl group-hover:block group-focus-within:block ${alignmentClass}`}
    >
      {description}
    </span>
  );
}

export function ColumnHeaderLabel({
  label,
  description,
  align = 'left',
}: {
  label: string;
  description: string;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <span
      tabIndex={0}
      aria-label={`${label}: ${description}`}
      className={`group relative inline-flex max-w-full cursor-help items-center ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''}`}
    >
      <span className="truncate">{label}</span>
      <ColumnHeaderTooltip description={description} align={align} />
    </span>
  );
}
