/**
 * telegram.ts — Direct Telegram notification helper
 *
 * Pure HTTP — no LLM, no dependencies beyond native fetch.
 * Silent fail: catch + console.error. Never breaks dispatch.
 *
 * Reads credentials from:
 *  1. Environment variables (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
 *  2. app_settings table (telegram_bot_token, telegram_chat_id)
 */

import { getDb } from '../db/client';

async function getCredentials(): Promise<{ token: string; chatId: string } | null> {
  // Env vars take priority
  let token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  let chatId = process.env.TELEGRAM_CHAT_ID ?? '';

  if (token && chatId) return { token, chatId };

  // Fall back to app_settings
  try {
    const db = getDb();
    const rows = await db.all("SELECT key, value FROM app_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id')") as { key: string; value: string }[];
    for (const r of rows) {
      if (r.key === 'telegram_bot_token' && !token) token = r.value;
      if (r.key === 'telegram_chat_id' && !chatId) chatId = r.value;
    }
  } catch {
    // Table may not exist yet during early init
  }

  if (!token || !chatId) return null;
  return { token, chatId };
}

export async function notifyTelegram(text: string): Promise<void> {
  const result = await sendTelegramNotification(text);
  if (!result.ok) console.error(`[telegram] ${result.error}`);
}

/** Acknowledged delivery for durable outboxes; never expose the bot URL/token in errors. */
export async function sendTelegramNotification(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const creds = await getCredentials();

  if (!creds) {
    return { ok: false, error: 'Telegram is not configured' };
  }

  try {
    const url = `https://api.telegram.org/bot${creds.token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: creds.chatId,
        text,
        parse_mode: 'HTML',
      }),
    });

    const body = await res.json() as { ok?: boolean };
    if (!res.ok || body.ok !== true) return { ok: false, error: `Telegram delivery was not acknowledged (HTTP ${res.status})` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Telegram delivery failed or timed out' };
  }
}
