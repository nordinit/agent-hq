const SETTINGS_TAB_SLUGS = new Set([
  'tenants',
  'display',
  'providers',
  'gateway',
  'notifications',
  'github',
  'logs',
  'api',
  'mcp',
]);

function normalizeTabSlug(value: string | null | undefined): string | null {
  const slug = value?.trim().replace(/^#/, '').replace(/^\/+/, '').split(/[/?#]/)[0].toLowerCase();
  return slug && SETTINGS_TAB_SLUGS.has(slug) ? slug : null;
}

export function resolveSettingsRouteTarget(tab: string | null | undefined, hash?: string | null): string {
  const explicitTab = normalizeTabSlug(tab) ?? normalizeTabSlug(hash);
  return `/settings/${explicitTab ?? 'tenants'}`;
}
