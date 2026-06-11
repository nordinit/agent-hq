const PROVIDER_LIMIT_PATTERNS = [
  /\bhttp\s*429\b/i,
  /\bstatus\s*429\b/i,
  /\berror\s*code:\s*429\b/i,
  /\brate[-\s]*limit(?:ed|s)?\b/i,
  /\brate_limit(?:ed|s)?\b/i,
  /\btoo many requests\b/i,
  /\binsufficient[_\s-]*quota\b/i,
  /\bquota\b/i,
  /\bquota exceeded\b/i,
] as const;

export function isProviderLimitFailureText(content: string): boolean {
  if (!content.trim()) return false;
  return PROVIDER_LIMIT_PATTERNS.some((pattern) => pattern.test(content));
}

export function trimProviderLimitFailureText(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  return normalized.length > 1200 ? `${normalized.slice(0, 1197)}...` : normalized;
}

export function detectProviderLimitFailureText(content: string): string | null {
  if (!isProviderLimitFailureText(content)) return null;
  return trimProviderLimitFailureText(content);
}
