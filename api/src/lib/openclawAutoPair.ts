/** Recognizes the OpenClaw gateway's "pairing required" refusals. */

export function isPairingRequiredText(text: string | null | undefined): boolean {
  const normalized = String(text ?? '').toLowerCase();
  return normalized.includes('pairing required') || normalized.includes('device identity required');
}

export function isPairingRequiredClose(code: number, reason: string | Buffer | Uint8Array | null | undefined): boolean {
  const reasonText = Buffer.isBuffer(reason)
    ? reason.toString('utf8')
    : reason instanceof Uint8Array
      ? Buffer.from(reason).toString('utf8')
      : String(reason ?? '');
  return code === 1008 && isPairingRequiredText(reasonText);
}
