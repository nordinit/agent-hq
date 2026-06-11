import { DEFAULT_THEME, THEME_STORAGE_KEY } from './themePreference';

export default function ThemeScript() {
  const script = `
(() => {
  try {
    const stored = window.localStorage.getItem('${THEME_STORAGE_KEY}');
    const theme = stored === 'light' || stored === 'dark' ? stored : '${DEFAULT_THEME}';
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.style.colorScheme = theme;
  } catch {
    document.documentElement.classList.add('${DEFAULT_THEME}');
    document.documentElement.style.colorScheme = '${DEFAULT_THEME}';
  }
})();
`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
