import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { deliverPendingNotifications } from './notificationDelivery';
const mockSend = jest.fn();
jest.mock('../integrations/telegram', () => ({ sendTelegramNotification: (...args: unknown[]) => mockSend(...args) }));

describe('recovery alert outbox', () => {
  const publicUrl = process.env.AGENT_HQ_PUBLIC_URL;
  const uiPublicUrl = process.env.AGENT_HQ_UI_PUBLIC_URL;
  beforeEach(async () => {
    await setupTestDb();
    await getDb().run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Test','test',1)");
    await getDb().run(`INSERT INTO notification_records (id,tenant_id,type,title,body,metadata_json)
      VALUES (1,1,'mcp_recovery_failed','Recovery failed','Needs <attention>','{}')`);
    await getDb().run("INSERT INTO notification_deliveries (notification_id,outlet) VALUES (1,'telegram')");
    mockSend.mockReset();
  });
  afterEach(async () => {
    if (publicUrl === undefined) delete process.env.AGENT_HQ_PUBLIC_URL;
    else process.env.AGENT_HQ_PUBLIC_URL = publicUrl;
    if (uiPublicUrl === undefined) delete process.env.AGENT_HQ_UI_PUBLIC_URL;
    else process.env.AGENT_HQ_UI_PUBLIC_URL = uiPublicUrl;
    await teardownTestDb();
  });
  it('uses only an explicitly configured dashboard origin for external links', async () => {
    const db = getDb();
    process.env.AGENT_HQ_PUBLIC_URL = 'https://mcp.example.test';
    delete process.env.AGENT_HQ_UI_PUBLIC_URL;
    await db.run('UPDATE notification_records SET metadata_json = ?', JSON.stringify({
      links: [{ label: 'Agent', href: '/agents/1' }],
    }));
    mockSend.mockResolvedValue({ ok: true });
    await deliverPendingNotifications(db);
    expect(mockSend.mock.calls[0][0]).not.toContain('<a href=');
    await db.run("UPDATE notification_deliveries SET state='pending'");
    process.env.AGENT_HQ_UI_PUBLIC_URL = 'https://dashboard.example.test';
    await deliverPendingNotifications(db);
    expect(mockSend.mock.calls[1][0]).toContain('<a href="https://dashboard.example.test/agents/1">Agent</a>');
    expect(mockSend.mock.calls[1][0]).not.toContain('mcp.example.test');
  });
  it('retains failure evidence and retries delivery independently of recovery', async () => {
    const db = getDb(); mockSend.mockResolvedValue({ ok: false, error: 'timeout' });
    await deliverPendingNotifications(db);
    expect(await db.get('SELECT state,last_error,attempts,sent_at FROM notification_deliveries')).toEqual({ state: 'pending', last_error: 'timeout', attempts: 1, sent_at: null });
    await deliverPendingNotifications(db);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await db.run("UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second'");
    mockSend.mockResolvedValue({ ok: true });
    await Promise.all([deliverPendingNotifications(db), deliverPendingNotifications(db)]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(await db.value('SELECT state FROM notification_deliveries')).toBe('sent');
    expect(mockSend.mock.calls[0][0]).toContain('&lt;attention&gt;');
  });
  it('recovers an expired send lease after restart and honors notification preferences', async () => {
    const db = getDb();
    await db.run("UPDATE notification_deliveries SET state='sending',lease_until=now()-interval '1 minute'");
    await db.run(`INSERT INTO app_settings (key,value) VALUES ('notifications.preferences.tenant.1','{"enabled":false}')`);
    await deliverPendingNotifications(db);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await db.value('SELECT state FROM notification_deliveries')).toBe('disabled');
  });
});
