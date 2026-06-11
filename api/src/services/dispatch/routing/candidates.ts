import type { CandidateTask } from '../types';

const PRIORITY_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * sortCandidates — sorts tasks using the provided sort_rules array.
 *
 * Supported rules (applied in order):
 *   "priority_desc"  -> high > medium > low
 *   "blocking_first" -> tasks blocking more others come first
 *   "oldest_first"   -> earliest created_at first
 *   "newest_first"   -> latest created_at first
 *
 * If sort_rules is empty/null, falls back to default order:
 *   priority_desc -> blocking_first -> oldest_first
 */
export function sortCandidates(candidates: CandidateTask[], sortRules?: string[]): CandidateTask[] {
  const rules: string[] =
    sortRules && sortRules.length > 0
      ? sortRules
      : ['priority_desc', 'blocking_first', 'oldest_first'];

  return [...candidates].sort((a, b) => {
    for (const rule of rules) {
      switch (rule) {
        case 'priority_desc': {
          const pa = PRIORITY_ORDER[a.priority] ?? 0;
          const pb = PRIORITY_ORDER[b.priority] ?? 0;
          if (pb !== pa) return pb - pa;
          break;
        }
        case 'blocking_first': {
          if (b.blocking_count !== a.blocking_count) return b.blocking_count - a.blocking_count;
          break;
        }
        case 'oldest_first': {
          const cmp = a.created_at.localeCompare(b.created_at);
          if (cmp !== 0) return cmp;
          break;
        }
        case 'newest_first': {
          const cmp = b.created_at.localeCompare(a.created_at);
          if (cmp !== 0) return cmp;
          break;
        }
        default:
          break;
      }
    }
    return 0;
  });
}
