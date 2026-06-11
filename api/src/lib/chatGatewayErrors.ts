function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeMeaningfulPlainText(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/[{};][^ ]/.test(trimmed)) return false;
  return /[a-z]{3,}/i.test(trimmed);
}

function truncateForUi(raw: string, maxLength = 280): string {
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength - 3).trimEnd()}...`;
}

function looksLikeHtml(raw: string): boolean {
  return /<(?:!doctype|html|head|body|script|style)\b/i.test(raw);
}

function isCodexChallengeHtml(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes('chatgpt.com/backend-api/v1/codex/responses')
    || lower.includes('__cf_chl')
    || lower.includes('enable javascript and cookies to continue')
    || lower.includes("czone: 'chatgpt.com'")
    || lower.includes('managed challenge')
  );
}

export function extractGatewayErrorMessage(value: unknown): string | null {
  return extractGatewayErrorMessageInternal(value, new Set<unknown>());
}

function extractGatewayErrorMessageInternal(value: unknown, seen: Set<unknown>): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractGatewayErrorMessageInternal(entry, seen);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const direct = firstNonEmptyString([
    record.errorMessage,
    record.error,
    record.summary,
    record.details,
    record.reasonDetail,
  ]);
  if (direct) return direct;

  const nestedValues = [
    record.error,
    record.message,
    record.data,
    record.payload,
    record.details,
    record.reasonDetail,
    record.cause,
  ];
  for (const nestedValue of nestedValues) {
    const nested = extractGatewayErrorMessageInternal(nestedValue, seen);
    if (nested) return nested;
  }

  return firstNonEmptyString([record.reason, record.stopReason]);
}

export function summarizeGatewayErrorForUi(value: unknown): string {
  const raw = extractGatewayErrorMessage(value);
  if (!raw) {
    return 'Agent run failed.';
  }

  const normalized = raw.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (
    lower.includes('dns lookup for the provider endpoint failed')
    || lower.includes('getaddrinfo')
    || lower.includes('enotfound')
    || lower.includes('eai_again')
    || lower.includes('name resolution')
  ) {
    return 'The machine running OpenClaw could not resolve the provider endpoint. Check its internet/DNS connection, then retry.';
  }

  if (lower.includes('device identity required')) {
    return 'OpenClaw device identity is required. Restart or pair the local gateway again, then retry.';
  }

  if (isCodexChallengeHtml(normalized)) {
    return 'OpenAI Codex authentication failed. Re-authenticate Codex CLI or OpenAI Codex, then retry.';
  }

  if (looksLikeHtml(normalized)) {
    const text = stripHtml(normalized);
    if (
      looksLikeMeaningfulPlainText(text)
      && text.toLowerCase() !== normalized.toLowerCase()
      && !text.toLowerCase().includes('font-family')
    ) {
      return truncateForUi(text);
    }
    return 'Provider returned an HTML challenge page instead of a model response. Re-authenticate the provider and retry.';
  }

  return truncateForUi(normalized);
}
