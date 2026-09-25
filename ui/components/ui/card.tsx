import React from 'react';

// Extra attributes (for example data-tour-target) pass through to the wrapper div.
export function Card({ children, className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`mb-4 ${className}`}>{children}</div>;
}

export function CardTitle({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <h3 className={`font-semibold text-white text-base ${className}`}>{children}</h3>;
}
