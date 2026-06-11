'use client';

import { useEffect, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { DEFAULT_THEME, isThemePreference, THEME_STORAGE_KEY, type ThemePreference } from '@/components/theme/themePreference';

const OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof Moon;
}> = [
  {
    value: 'dark',
    label: 'Dark',
    description: 'The default Agent HQ workspace theme.',
    icon: Moon,
  },
  {
    value: 'light',
    label: 'Light',
    description: 'A brighter interface for high ambient light.',
    icon: Sun,
  },
];

function applyTheme(theme: ThemePreference) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

export default function SettingsDisplayPage() {
  const [theme, setTheme] = useState<ThemePreference>(DEFAULT_THEME);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme = isThemePreference(stored) ? stored : DEFAULT_THEME;
    setTheme(initialTheme);
    applyTheme(initialTheme);
  }, []);

  const selectTheme = (nextTheme: ThemePreference) => {
    setTheme(nextTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    applyTheme(nextTheme);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-amber-300">
          <Monitor className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Display</h2>
          <p className="mt-1 text-sm leading-6 text-slate-400">
            Choose how Agent HQ renders the workspace. The preference is saved in this browser and applied on reload.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {OPTIONS.map(option => {
          const Icon = option.icon;
          const active = theme === option.value;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => selectTheme(option.value)}
              className={`flex min-h-32 items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                active
                  ? 'border-amber-400 bg-amber-500/10 ring-1 ring-amber-400/30'
                  : 'border-slate-700 bg-slate-800/40 hover:border-slate-500 hover:bg-slate-800/70'
              }`}
              aria-pressed={active}
            >
              <span className={`rounded-lg border p-2 ${active ? 'border-amber-400/40 bg-amber-400/15 text-amber-300' : 'border-slate-700 bg-slate-900 text-slate-300'}`}>
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white">{option.label}</span>
                  {active && <Check className="h-4 w-4 shrink-0 text-amber-300" />}
                </span>
                <span className="mt-2 block text-sm leading-6 text-slate-400">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
