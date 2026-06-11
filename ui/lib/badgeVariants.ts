export const BADGE_VARIANT_CLASSES = {
  queued: 'bg-slate-700 text-slate-300',
  starting: 'bg-orange-900/60 text-orange-300',
  running: 'bg-amber-900/60 text-amber-300',
  awaiting_outcome: 'bg-amber-900/60 text-amber-200 border border-amber-500/30',
  done: 'bg-green-900/60 text-green-300',
  failed: 'bg-red-900/60 text-red-300',
  idle: 'bg-green-900/60 text-green-300',
  blocked: 'bg-red-900/60 text-red-300',
  info: 'bg-blue-900/60 text-blue-300',
  warn: 'bg-amber-900/60 text-amber-300',
  error: 'bg-red-900/60 text-red-300',
  debug: 'bg-slate-700 text-slate-400',
  default: 'bg-slate-700 text-slate-300',
  workspace: 'bg-violet-900/60 text-violet-300',
  system: 'bg-slate-700 text-slate-400',
  stalled: 'bg-orange-900/60 text-orange-300',
  deployed: 'bg-cyan-900/60 text-cyan-300',
  review: 'bg-purple-900/60 text-purple-300',
} as const;

export type BadgeVariant = keyof typeof BADGE_VARIANT_CLASSES;

export const BADGE_VARIANTS = Object.keys(BADGE_VARIANT_CLASSES) as BadgeVariant[];

export const OUTCOME_BADGE_VARIANTS: BadgeVariant[] = [
  'workspace',
  'queued',
  'review',
  'deployed',
  'done',
  'stalled',
  'failed',
  'blocked',
  'info',
  'warn',
  'error',
  'default',
];

export function isBadgeVariant(value: unknown): value is BadgeVariant {
  return typeof value === 'string' && value in BADGE_VARIANT_CLASSES;
}

export function getBadgeVariantClass(variant: string | null | undefined, fallback: BadgeVariant = 'workspace'): string {
  return isBadgeVariant(variant) ? BADGE_VARIANT_CLASSES[variant] : BADGE_VARIANT_CLASSES[fallback];
}
