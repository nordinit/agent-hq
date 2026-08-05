/**
 * Remove common credential shapes before runtime diagnostics are logged or
 * persisted. Model transcripts are intentionally not passed through this
 * helper; it protects infrastructure/error metadata, not user-authored content.
 */
export function redactSensitiveRuntimeText(value: string): string {
  return value
    .replace(
      /("(?:access_token|refresh_token|id_token|api[_-]?key|token|secret|password|credential)"\s*:\s*")[^"]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(?<![?&])\b([A-Z0-9_]{0,128}(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]{0,64}\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ahq_mcp_[A-Za-z0-9._-]+)\b/g, '[REDACTED]')
    .replace(
      /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^:\s/@]+:)[^@\s/]+@/gi,
      '$1[REDACTED]@',
    )
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|token|secret|password|credential|authorization|signature|sig|oauth[_-]?code|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s]*/gi,
      '$1[REDACTED]',
    );
}

const SENSITIVE_RUNTIME_ARGUMENT = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|token|secret|password|credential|authorization|cookie|private[_-]?key)/i;

/**
 * Produce the argv representation that is safe to persist in a durable launch
 * record. The process still receives the original vector; only this audit copy
 * is redacted. Adapter-owned flags are intentionally retained for diagnosis.
 */
export function sanitizeRuntimeLaunchArguments(values: readonly string[]): string[] {
  const sanitized: string[] = [];
  let redactNext = false;

  for (const value of values) {
    if (redactNext) {
      sanitized.push('[REDACTED]');
      redactNext = false;
      continue;
    }

    const equals = value.indexOf('=');
    const flag = equals >= 0 ? value.slice(0, equals) : value;
    if (flag.startsWith('-') && SENSITIVE_RUNTIME_ARGUMENT.test(flag)) {
      sanitized.push(equals >= 0 ? `${flag}=[REDACTED]` : flag);
      redactNext = equals < 0;
      continue;
    }

    sanitized.push(redactSensitiveRuntimeText(value));
  }

  return sanitized;
}
