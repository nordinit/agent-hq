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

function getCredentials(): { token: string; chatId: string } | null {
  // Env vars take priority
  let token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  let chatId = process.env.TELEGRAM_CHAT_ID ?? '';

  if (token && chatId) return { token, chatId };

  // Fall back to app_settings
  try {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM app_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id')").all() as { key: string; value: string }[];
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
  const creds = getCredentials();

  if (!creds) {
    console.error('[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — skipping notification');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${creds.token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: creds.chatId,
        text,
        parse_mode: 'HTML',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[telegram] sendMessage failed (${res.status}): ${body}`);
    }
  } catch (err) {
    console.error('[telegram] Notification error:', err);
  }
}
