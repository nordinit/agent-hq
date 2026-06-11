'use client';

import { useEffect, useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

type ScheduleType =
  | 'manual'
  | 'minutes'
  | 'hours'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'custom';

interface CronBuilderProps {
  value: string;
  onChange: (cron: string) => void;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const INPUT_CLS =
  'bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500';

// ─── Helper: describe a cron string in plain English ─────────────────────────

export function describeCron(cron: string): string {
  if (!cron || cron.trim() === '') return 'No schedule — fire manually only';

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [min, hour, dom, month, dow] = parts;

  // Every N minutes
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(everyMin[1]);
    return `Every ${n} minute${n === 1 ? '' : 's'}`;
  }

  // Every N hours
  const everyHr = hour.match(/^\*\/(\d+)$/);
  if (min === '0' && everyHr && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(everyHr[1]);
    return `Every ${n} hour${n === 1 ? '' : 's'}`;
  }

  // Time-based patterns
  const isTime = /^\d+$/.test(min) && /^\d+$/.test(hour) && month === '*';
  if (isTime) {
    const m = parseInt(min);
    const h = parseInt(hour);
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const minStr = m.toString().padStart(2, '0');
    const timeStr = `${h12}:${minStr} ${ampm}`;

    // Monthly on day N at…
    if (/^\d+$/.test(dom) && dow === '*') {
      return `Monthly on day ${dom} at ${timeStr}`;
    }

    // Weekdays Mon–Fri
    if (dom === '*' && dow === '1-5') {
      return `Weekdays at ${timeStr}`;
    }

    // Weekly on a specific day
    if (dom === '*' && /^\d$/.test(dow)) {
      return `Every ${DAY_NAMES[parseInt(dow)]} at ${timeStr}`;
    }

    // Daily
    if (dom === '*' && dow === '*') {
      return `Every day at ${timeStr}`;
    }
  }

  return cron; // fallback: show raw
}

// ─── Helper: parse cron → UI state ───────────────────────────────────────────

interface UIState {
  type: ScheduleType;
  everyN: number;
  hour12: number;
  minute: number;
  ampm: 'AM' | 'PM';
  dayOfWeek: number;
  dayOfMonth: number;
  custom: string;
}

function defaultUI(): UIState {
  return {
    type: 'manual',
    everyN: 5,
    hour12: 9,
    minute: 0,
    ampm: 'AM',
    dayOfWeek: 1,
    dayOfMonth: 1,
    custom: '',
  };
}

function parseCron(cron: string): UIState {
  const base = defaultUI();
  if (!cron || cron.trim() === '') return { ...base, type: 'manual' };

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, type: 'custom', custom: cron };

  const [min, hour, dom, month, dow] = parts;

  // Every N minutes
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { ...base, type: 'minutes', everyN: parseInt(everyMin[1]) };
  }

  // Every N hours
  const everyHr = hour.match(/^\*\/(\d+)$/);
  if (min === '0' && everyHr && dom === '*' && month === '*' && dow === '*') {
    return { ...base, type: 'hours', everyN: parseInt(everyHr[1]) };
  }

  // Time-based
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && month === '*') {
    const h24 = parseInt(hour);
    const m = parseInt(min);
    const ampm: 'AM' | 'PM' = h24 < 12 ? 'AM' : 'PM';
    const hour12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;

    // Monthly
    if (/^\d+$/.test(dom) && dow === '*') {
      return { ...base, type: 'monthly', hour12, minute: m, ampm, dayOfMonth: parseInt(dom) };
    }

    // Weekdays
    if (dom === '*' && dow === '1-5') {
      return { ...base, type: 'weekdays', hour12, minute: m, ampm };
    }

    // Weekly
    if (dom === '*' && /^\d$/.test(dow)) {
      return { ...base, type: 'weekly', hour12, minute: m, ampm, dayOfWeek: parseInt(dow) };
    }

    // Daily
    if (dom === '*' && dow === '*') {
      return { ...base, type: 'daily', hour12, minute: m, ampm };
    }
  }

  return { ...base, type: 'custom', custom: cron };
}

// ─── Helper: UI state → cron string ──────────────────────────────────────────

function buildCron(ui: UIState): string {
  const h24 = ui.ampm === 'AM'
    ? (ui.hour12 === 12 ? 0 : ui.hour12)
    : (ui.hour12 === 12 ? 12 : ui.hour12 + 12);

  switch (ui.type) {
    case 'manual':   return '';
    case 'minutes':  return `*/${ui.everyN} * * * *`;
    case 'hours':    return `0 */${ui.everyN} * * *`;
    case 'daily':    return `${ui.minute} ${h24} * * *`;
    case 'weekdays': return `${ui.minute} ${h24} * * 1-5`;
    case 'weekly':   return `${ui.minute} ${h24} * * ${ui.dayOfWeek}`;
    case 'monthly':  return `${ui.minute} ${h24} ${ui.dayOfMonth} * *`;
    case 'custom':   return ui.custom;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TimeInputs({
  ui,
  onChange,
}: {
  ui: UIState;
  onChange: (patch: Partial<UIState>) => void;
}) {
  return (
    <>
      <select
        className={INPUT_CLS}
        value={ui.hour12}
        onChange={e => onChange({ hour12: parseInt(e.target.value) })}
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map(h => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>

      <select
        className={INPUT_CLS}
        value={ui.minute}
        onChange={e => onChange({ minute: parseInt(e.target.value) })}
      >
        {[0, 15, 30, 45].map(m => (
          <option key={m} value={m}>{m.toString().padStart(2, '0')}</option>
        ))}
      </select>

      <select
        className={INPUT_CLS}
        value={ui.ampm}
        onChange={e => onChange({ ampm: e.target.value as 'AM' | 'PM' })}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CronBuilder({ value, onChange }: CronBuilderProps) {
  const [ui, setUI] = useState<UIState>(() => parseCron(value));

  // Re-parse when the external value changes (e.g. edit mode loads a saved job)
  useEffect(() => {
    setUI(parseCron(value));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (patch: Partial<UIState>) => {
    setUI(prev => {
      const next = { ...prev, ...patch };
      onChange(buildCron(next));
      return next;
    });
  };

  const preview = describeCron(buildCron(ui));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Schedule type */}
        <select
          className={INPUT_CLS}
          value={ui.type}
          onChange={e => update({ type: e.target.value as ScheduleType })}
        >
          <option value="manual">Manual only (no schedule)</option>
          <option value="minutes">Every N minutes</option>
          <option value="hours">Every N hours</option>
          <option value="daily">Daily at…</option>
          <option value="weekdays">Weekdays at… (Mon–Fri)</option>
          <option value="weekly">Weekly on…</option>
          <option value="monthly">Monthly on day…</option>
          <option value="custom">Custom (advanced)</option>
        </select>

        {/* Every N minutes */}
        {ui.type === 'minutes' && (
          <>
            <span className="text-slate-400 text-sm">every</span>
            <input
              type="number"
              min={1}
              max={59}
              className={`${INPUT_CLS} w-20`}
              value={ui.everyN}
              onChange={e => update({ everyN: Math.max(1, Math.min(59, parseInt(e.target.value) || 1)) })}
            />
            <span className="text-slate-400 text-sm">min</span>
          </>
        )}

        {/* Every N hours */}
        {ui.type === 'hours' && (
          <>
            <span className="text-slate-400 text-sm">every</span>
            <input
              type="number"
              min={1}
              max={23}
              className={`${INPUT_CLS} w-20`}
              value={ui.everyN}
              onChange={e => update({ everyN: Math.max(1, Math.min(23, parseInt(e.target.value) || 1)) })}
            />
            <span className="text-slate-400 text-sm">hr</span>
          </>
        )}

        {/* Daily */}
        {ui.type === 'daily' && (
          <TimeInputs ui={ui} onChange={update} />
        )}

        {/* Weekdays */}
        {ui.type === 'weekdays' && (
          <TimeInputs ui={ui} onChange={update} />
        )}

        {/* Weekly */}
        {ui.type === 'weekly' && (
          <>
            <select
              className={INPUT_CLS}
              value={ui.dayOfWeek}
              onChange={e => update({ dayOfWeek: parseInt(e.target.value) })}
            >
              {DAY_NAMES.map((name, i) => (
                <option key={i} value={i}>{name}</option>
              ))}
            </select>
            <TimeInputs ui={ui} onChange={update} />
          </>
        )}

        {/* Monthly */}
        {ui.type === 'monthly' && (
          <>
            <span className="text-slate-400 text-sm">day</span>
            <input
              type="number"
              min={1}
              max={31}
              className={`${INPUT_CLS} w-20`}
              value={ui.dayOfMonth}
              onChange={e => update({ dayOfMonth: Math.max(1, Math.min(31, parseInt(e.target.value) || 1)) })}
            />
            <TimeInputs ui={ui} onChange={update} />
          </>
        )}

        {/* Custom */}
        {ui.type === 'custom' && (
          <input
            type="text"
            className={`${INPUT_CLS} font-mono w-44`}
            value={ui.custom}
            onChange={e => update({ custom: e.target.value })}
            placeholder="0 9 * * 1-5"
          />
        )}
      </div>

      {/* Human-readable preview */}
      <p className="text-xs text-amber-300 mt-1">{preview}</p>
    </div>
  );
}
