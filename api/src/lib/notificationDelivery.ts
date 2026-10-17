import { randomUUID } from 'crypto';
import type { Db } from '../db/adapter/types';
import { readNotificationPreferences } from './notifications';
import { sendTelegramNotification } from '../integrations/telegram';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function telegramLinks(metadata: string): string {
  try {
    const origin = new URL(process.env.AGENT_HQ_PUBLIC_URL ?? '');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return '';
    const links: unknown = JSON.parse(metadata).links;
    if (!Array.isArray(links)) return '';
    return links.filter((l): l is { label: string; href: string } => l && typeof l.label === 'string'
      && typeof l.href === 'string' && /^\/(agents|tasks)\/\d+$/.test(l.href)).slice(0, 8)
      .map(l => `<a href="${escapeHtml(new URL(l.href, origin).toString())}">${escapeHtml(l.label)}</a>`).join(' · ');
  } catch { return ''; }
}

/** Claim before sending; a crash or rejected send remains retryable after the lease expires. */
export async function deliverPendingNotifications(db: Db): Promise<void> {
  for (let n = 0; n < 8; n++) {
    const token = randomUUID();
    const row = await db.get<{ id: number; notification_id: number; attempts: number }>(`
      UPDATE notification_deliveries SET state = 'sending', claim_token = ?, lease_until = now() + interval '30 seconds', attempts = attempts + 1
      WHERE id = (SELECT id FROM notification_deliveries WHERE state IN ('pending', 'sending')
        AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, notification_id, attempts`, token);
    if (!row) return;
    const notification = await db.get<{ tenant_id: number; title: string; body: string; metadata_json: string }>(
      'SELECT tenant_id, title, body, metadata_json FROM notification_records WHERE id = ?', row.notification_id);
    if (!notification) continue;
    const prefs = await readNotificationPreferences(db, notification.tenant_id);
    if (!prefs.enabled || !prefs.outlets.telegram) {
      await db.run("UPDATE notification_deliveries SET state = 'disabled', lease_until = NULL WHERE id = ? AND claim_token = ?", row.id, token);
      continue;
    }
    // Relative links are always available in HQ. External delivery gets links only with a configured public origin.
    const suffix = telegramLinks(notification.metadata_json);
    const result = await sendTelegramNotification(`${escapeHtml(notification.body.slice(0, 3000))}${suffix ? `\n${suffix}` : ''}\nAlert #${row.notification_id}`);
    if (result.ok) await db.run(`UPDATE notification_deliveries SET state = 'sent', sent_at = now(), lease_until = NULL, last_error = NULL
      WHERE id = ? AND claim_token = ?`, row.id, token);
    else await db.run(`UPDATE notification_deliveries SET state = 'pending', lease_until = NULL, last_error = ?,
      next_attempt_at = now() + (? * interval '1 second') WHERE id = ? AND claim_token = ?`,
    result.error, Math.min(300, 15 * 2 ** Math.min(row.attempts - 1, 5)), row.id, token);
  }
}
