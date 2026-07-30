import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { probeGateway } from '../lib/gatewayHealth';
import { pairGateway } from '../lib/gatewayPair';
import { readGatewaySettings, saveGatewaySettings, type GatewayRuntimeHint } from '../lib/gatewaySettings';
import { ensureOpenClawGatewayAvailable } from '../lib/openclawCli';
import {
  listNotificationRecordsPage,
  notificationTenantIdFromRequest,
  readNotificationPreferences,
  saveNotificationPreferences,
  unreadNotificationCount,
} from '../lib/notifications';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
  const db = getDb();
  const row = await db.get('SELECT value FROM app_settings WHERE key = ?', key) as { value: string } | undefined;
  return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `, key, value);
}

// ─── GET /api/v1/settings/telegram ───────────────────────────────────────────
// Returns current Telegram config (token is masked for security)
router.get('/telegram', async (_req: Request, res: Response) => {
  try {
    const botToken = (await getSetting('telegram_bot_token')) ?? '';
    const chatId = (await getSetting('telegram_chat_id')) ?? '';
    const connected = !!(botToken && chatId);

    res.json({
      connected,
      chatId: chatId || null,
      botTokenSet: !!botToken,
      // Mask token: show first 5 and last 4 chars
      botTokenMasked: botToken
        ? `${botToken.slice(0, 5)}${'*'.repeat(Math.max(0, botToken.length - 9))}${botToken.slice(-4)}`
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── PUT /api/v1/settings/telegram ───────────────────────────────────────────
// Save Telegram bot token + chat ID
router.put('/telegram', async (req: Request, res: Response) => {
  try {
    const { botToken, chatId } = req.body;

    if (typeof botToken !== 'string' || typeof chatId !== 'string') {
      res.status(400).json({ error: 'botToken and chatId are required strings' });
      return;
    }

    if (!botToken.trim() || !chatId.trim()) {
      res.status(400).json({ error: 'botToken and chatId must not be empty' });
      return;
    }

    await setSetting('telegram_bot_token', botToken.trim());
    await setSetting('telegram_chat_id', chatId.trim());

    res.json({ ok: true, connected: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── DELETE /api/v1/settings/telegram ────────────────────────────────────────
// Disconnect Telegram
router.delete('/telegram', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    await db.run("DELETE FROM app_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id')");
    res.json({ ok: true, connected: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/v1/settings/telegram/test ─────────────────────────────────────
// Test the saved (or provided) Telegram connection
router.post('/telegram/test', async (req: Request, res: Response) => {
  try {
    // Allow testing with provided creds or saved ones
    let botToken = (req.body.botToken as string)?.trim();
    let chatId = (req.body.chatId as string)?.trim();

    if (!botToken) botToken = (await getSetting('telegram_bot_token')) ?? '';
    if (!chatId) chatId = (await getSetting('telegram_chat_id')) ?? '';

    if (!botToken || !chatId) {
      res.status(400).json({ ok: false, error: 'No Telegram credentials configured' });
      return;
    }

    // Verify bot token by calling getMe
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = await meRes.json() as { ok: boolean; result?: { username?: string }; description?: string };

    if (!meData.ok) {
      res.json({ ok: false, error: `Invalid bot token: ${meData.description || 'unknown error'}` });
      return;
    }

    // Try sending a test message
    const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ Agent HQ — Telegram connection test successful!',
        parse_mode: 'HTML',
      }),
    });
    const sendData = await sendRes.json() as { ok: boolean; description?: string };

    if (!sendData.ok) {
      res.json({
        ok: false,
        error: `Bot valid (@${meData.result?.username}), but message failed: ${sendData.description || 'unknown error'}`,
      });
      return;
    }

    res.json({
      ok: true,
      botUsername: meData.result?.username || null,
      message: `Test message sent via @${meData.result?.username}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── GET /api/v1/settings/notifications ─────────────────────────────────────
// Notification preferences, supported outlets, and persistent notification history.
router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await notificationTenantIdFromRequest(db, req);
    const limit = Number(req.query.limit ?? 50);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const botToken = (await getSetting('telegram_bot_token')) ?? '';
    const chatId = (await getSetting('telegram_chat_id')) ?? '';
    const preferences = await readNotificationPreferences(db, tenantId);
    const page = await listNotificationRecordsPage(db, tenantId, { limit, cursor });
    res.json({
      ok: true,
      tenant_id: tenantId,
      preferences,
      outlets: {
        telegram: {
          supported: true,
          configured: Boolean(botToken && chatId),
          enabled: preferences.enabled && preferences.outlets.telegram,
          chatId: chatId || null,
          botTokenSet: Boolean(botToken),
        },
      },
      records: page.records,
      pagination: {
        limit: page.limit,
        next_cursor: page.nextCursor,
      },
      unread_count: await unreadNotificationCount(db, tenantId),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── PUT /api/v1/settings/notifications/preferences ─────────────────────────
// Persist current-user notification delivery and live UI preferences.
router.put('/notifications/preferences', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await notificationTenantIdFromRequest(db, req);
    const body = req.body && typeof req.body === 'object' ? req.body as {
      enabled?: unknown;
      liveEnabled?: unknown;
      outlets?: { telegram?: unknown };
    } : {};
    const patch: Parameters<typeof saveNotificationPreferences>[0] = {
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.liveEnabled === 'boolean' ? { liveEnabled: body.liveEnabled } : {}),
      ...(typeof body.outlets?.telegram === 'boolean' ? { outlets: { telegram: body.outlets.telegram } } : {}),
    };
    const preferences = await saveNotificationPreferences(patch, db, tenantId);
    res.json({ ok: true, tenant_id: tenantId, preferences });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── POST /api/v1/settings/gateway/restart ───────────────────────────────────
// Restart the local OpenClaw gateway service.
router.get('/gateway/config', async (_req: Request, res: Response) => {
  try {
    const settings = await readGatewaySettings();
    res.json({
      ok: true,
      ws_url: settings.wsUrl,
      http_url: settings.httpUrl,
      runtime_hint: settings.runtimeHint,
      auth_token: settings.authToken,
      auth_token_configured: settings.authTokenConfigured,
      auth_token_source: settings.authTokenSource,
      source: settings.source,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.put('/gateway/config', async (req: Request, res: Response) => {
  try {
    const wsUrl = typeof req.body?.ws_url === 'string' ? req.body.ws_url.trim() : '';
    const runtimeHint = typeof req.body?.runtime_hint === 'string'
      ? req.body.runtime_hint.trim().toLowerCase()
      : '';
    const authToken = typeof req.body?.auth_token === 'string'
      ? req.body.auth_token
      : null;

    if (!wsUrl) {
      return res.status(400).json({ ok: false, error: 'ws_url is required' });
    }

    const allowedHints: GatewayRuntimeHint[] = ['powershell', 'wsl', 'macos', 'linux', 'external'];
    if (!allowedHints.includes(runtimeHint as GatewayRuntimeHint)) {
      return res.status(400).json({ ok: false, error: 'runtime_hint is invalid' });
    }

    const saved = await saveGatewaySettings({
          wsUrl,
          runtimeHint: runtimeHint as GatewayRuntimeHint,
          authToken,
        });
    const settings = await readGatewaySettings();

    return res.json({
      ok: true,
      ws_url: saved.wsUrl,
      http_url: saved.httpUrl,
      runtime_hint: saved.runtimeHint,
      auth_token: settings.authToken,
      auth_token_configured: settings.authTokenConfigured,
      auth_token_source: settings.authTokenSource,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

router.get('/gateway/status', async (_req: Request, res: Response) => {
  try {
    const settings = await readGatewaySettings();
    const probe = await probeGateway(settings.wsUrl);
    return res.json({
      ok: true,
      ws_url: settings.wsUrl,
      http_url: settings.httpUrl,
      runtime_hint: settings.runtimeHint,
      auth_token_configured: settings.authTokenConfigured,
      auth_token_source: settings.authTokenSource,
      source: settings.source,
      state: probe.state,
      reachable: probe.reachable,
      pairing_required: probe.pairing_required,
      checked_at: probe.checked_at,
      error: probe.error,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post('/gateway/pair', async (_req: Request, res: Response) => {
  try {
    const settings = await readGatewaySettings();
    const result = await pairGateway(settings.wsUrl, settings.runtimeHint);
    return res.json({
      ok: true,
      ws_url: settings.wsUrl,
      http_url: settings.httpUrl,
      runtime_hint: settings.runtimeHint,
      source: settings.source,
      state: result.state,
      reachable: result.reachable,
      pairing_required: result.pairing_required,
      checked_at: result.checked_at,
      error: result.error,
      auto_pair_supported: result.auto_pair_supported,
      manual_required: result.manual_required,
      pairing_approved: result.pairing_approved,
      message: result.message,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post('/gateway/restart', (_req: Request, res: Response) => {
  try {
    const gateway = ensureOpenClawGatewayAvailable();
    if (!gateway.ok) {
      return res.status(500).json({
        ok: false,
        error: `Failed to restart OpenClaw gateway: ${gateway.message}`,
      });
    }
    res.json({
      ok: true,
      message: gateway.usedDirectFallback
        ? 'OpenClaw gateway started in direct background mode.'
        : gateway.repaired
          ? 'OpenClaw gateway command was repaired and the gateway was restarted successfully.'
          : 'OpenClaw gateway restarted successfully.',
      output: gateway.message || null,
      pairing_approved: false,
      pairing_message: 'Pairing is manual. If the gateway asks for pairing, approve the pending request with `openclaw devices list` and `openclaw devices approve <requestId>`.',
    });
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      ok: false,
      error: `Failed to restart OpenClaw gateway: ${output}`,
    });
  }
});

export default router;
