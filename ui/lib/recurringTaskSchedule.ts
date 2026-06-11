export const MINUTE_INTERVAL_MIN = 5;
export const MINUTE_INTERVAL_MAX = 1440;

export type RecurringScheduleKind = 'minutes' | 'daily' | 'weekly' | 'custom';

export type RecurringScheduleFormFields = {
  schedule_kind: RecurringScheduleKind;
  minute_interval: number | '';
  weekday: string;
  schedule_time: string;
  custom_schedule: string;
};

const WEEKDAY_PATTERN = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';

export function parseScheduleExpression(expression: string): RecurringScheduleFormFields {
  const source = expression.trim();
  const normalized = source.toLowerCase().replace(/\s+/g, ' ');
  const minutes = /^every ([1-9]\d*) minutes?$/.exec(normalized);
  if (minutes) {
    return {
      schedule_kind: 'minutes',
      minute_interval: Number(minutes[1]),
      weekday: 'monday',
      schedule_time: '09:00',
      custom_schedule: '',
    };
  }

  const daily = /^every day(?: at)? ([0-2]\d:[0-5]\d)$/.exec(normalized);
  if (daily) {
    return {
      schedule_kind: 'daily',
      minute_interval: MINUTE_INTERVAL_MIN,
      weekday: 'monday',
      schedule_time: daily[1],
      custom_schedule: '',
    };
  }

  const weekly = new RegExp(`^every (${WEEKDAY_PATTERN})(?: at)? ([0-2]\\d:[0-5]\\d)$`).exec(normalized);
  if (weekly) {
    return {
      schedule_kind: 'weekly',
      minute_interval: MINUTE_INTERVAL_MIN,
      weekday: weekly[1],
      schedule_time: weekly[2],
      custom_schedule: '',
    };
  }

  return {
    schedule_kind: 'custom',
    minute_interval: MINUTE_INTERVAL_MIN,
    weekday: 'monday',
    schedule_time: '09:00',
    custom_schedule: source,
  };
}

export function validateMinuteInterval(interval: number | ''): string | undefined {
  if (interval === '') return 'Enter a minute interval.';
  if (!Number.isInteger(interval)) return 'Use a whole number of minutes.';
  if (interval < MINUTE_INTERVAL_MIN) return `Use at least ${MINUTE_INTERVAL_MIN} minutes.`;
  if (interval > MINUTE_INTERVAL_MAX) return `Use ${MINUTE_INTERVAL_MAX} minutes or less.`;
  return undefined;
}

export function shouldClearLoadedWorkflowSelection(
  selectedValue: string,
  validValues: readonly string[],
  loading: boolean,
): boolean {
  if (!selectedValue || loading) return false;
  return !validValues.includes(selectedValue);
}

export function buildScheduleExpression(form: RecurringScheduleFormFields): string {
  if (form.schedule_kind === 'minutes') return `every ${form.minute_interval} minutes`;
  if (form.schedule_kind === 'weekly') return `every ${form.weekday} ${form.schedule_time}`;
  if (form.schedule_kind === 'custom') return form.custom_schedule.trim();
  return `every day ${form.schedule_time}`;
}

export function formatScheduleExpression(expression: string | null | undefined): string {
  const value = expression?.trim();
  if (!value) return '-';
  const parsed = parseScheduleExpression(value);
  if (parsed.schedule_kind === 'minutes') {
    return `Every ${parsed.minute_interval} minute${parsed.minute_interval === 1 ? '' : 's'}`;
  }
  if (parsed.schedule_kind === 'daily') return `Daily at ${parsed.schedule_time}`;
  if (parsed.schedule_kind === 'weekly') {
    return `Every ${parsed.weekday[0].toUpperCase() + parsed.weekday.slice(1)} at ${parsed.schedule_time}`;
  }
  return value;
}
