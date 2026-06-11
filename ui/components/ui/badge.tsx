import React from 'react';
import { BADGE_VARIANT_CLASSES, type BadgeVariant } from '@/lib/badgeVariants';

export function Badge({ variant = 'default', children, className }: { variant?: BadgeVariant; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${BADGE_VARIANT_CLASSES[variant]} ${className ?? ''}`}>
      {children}
    </span>
  );
}

export function StatusDot({ status }: { status: 'idle' | 'running' | 'blocked' }) {
  const colorClass = {
    idle: 'bg-green-400',
    running: 'bg-amber-400 animate-pulse',
    blocked: 'bg-red-400',
  }[status];

  return <span className={`inline-block w-2 h-2 rounded-full ${colorClass}`} />;
}
