const TZ = 'America/New_York';

/**
 * Parse a date string from the DB (may be missing the 'Z' suffix for UTC).
 * SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" without timezone info —
 * we treat them as UTC and append 'Z' so JS parses them correctly.
 */
export function parseDbDate(dateStr: string): Date {
  if (!dateStr) return new Date(NaN);
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  const withZ = normalized.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(normalized)
    ? normalized
    : normalized + 'Z';
  return new Date(withZ);
}

/** Full date + time: "Mar 9, 2026, 5:34 PM" */
export function formatDateTime(dateStr: string | Date): string {
  const d = dateStr instanceof Date ? dateStr : parseDbDate(dateStr as string);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Date only: "Mar 9, 2026" */
export function formatDate(dateStr: string | Date): string {
  const d = dateStr instanceof Date ? dateStr : parseDbDate(dateStr as string);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Time only: "5:34 PM" */
export function formatTime(dateStr: string | Date): string {
  const d = dateStr instanceof Date ? dateStr : parseDbDate(dateStr as string);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Relative time: "5m ago", "2h ago", "3d ago" */
export function timeAgo(dateStr: string | Date): string {
  const d = dateStr instanceof Date ? dateStr : parseDbDate(dateStr as string);
  if (isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
