export type ThemePreference = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'agent-hq-theme';
export const DEFAULT_THEME: ThemePreference = 'dark';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light';
}
