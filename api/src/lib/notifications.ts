import type { Request } from 'express';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from './tenantContext';
import { type Db } from "../db/adapter/types";

const PREF_KEY = 'notifications.preferences';

export interface NotificationPreferences {
  enabled: boolean;
  liveEnabled: boolean;
  outlets: {
    telegram: boolean;
  };
}

export interface NotificationRecordInput {
  tenantId: number;
  type: string;
  title: string;
  body: string;
  source?: string | null;
  outlet?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NotificationRecord {
  id: number;
  tenant_id: number;
  type: string;
  title: string;
  body: string;
  source: string | null;
  outlet: string | null;
  metadata_json: string;
  created_at: string;
}

export interface NotificationPage {
  records: NotificationRecord[];
  nextCursor: string | null;
  limit: number;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  liveEnabled: true,
  outlets: {
    telegram: true,
  },
};

export async function ensureNotificationTables(db: Db = getDb()): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notification_records (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      type          TEXT NOT NULL,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      source        TEXT,
      outlet        TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notification_records_tenant_created
      ON notification_records(tenant_id, created_at DESC, id DESC);
  `);
}

function normalizePreferences(raw: unknown): NotificationPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_NOTIFICATION_PREFERENCES;
  const record = raw as Record<string, unknown>;
  const outlets = record.outlets && typeof record.outlets === 'object' && !Array.isArray(record.outlets)
    ? record.outlets as Record<string, unknown>
    : {};
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_NOTIFICATION_PREFERENCES.enabled,
    liveEnabled: typeof record.liveEnabled === 'boolean' ? record.liveEnabled : DEFAULT_NOTIFICATION_PREFERENCES.liveEnabled,
    outlets: {
      telegram: typeof outlets.telegram === 'boolean' ? outlets.telegram : DEFAULT_NOTIFICATION_PREFERENCES.outlets.telegram,
    },
  };
}

function preferenceKey(tenantId?: number | null): string {
  return Number.isInteger(tenantId) && Number(tenantId) > 0
    ? `${PREF_KEY}.tenant.${tenantId}`
    : PREF_KEY;
}

export async function readNotificationPreferences(db: Db = getDb(), tenantId?: number | null): Promise<NotificationPreferences> {
  const keys = tenantId ? [preferenceKey(tenantId), PREF_KEY] : [PREF_KEY];
  const placeholders = keys.map(() => '?').join(', ');
  const row = await db.get(`
    SELECT value
    FROM app_settings
    WHERE key IN (${placeholders})
    ORDER BY CASE key ${keys.map((_, index) => `WHEN ? THEN ${index}`).join(' ')} ELSE ${keys.length} END
    LIMIT 1
  `, ...keys, ...keys) as { value: string } | undefined;
  if (!row?.value) return DEFAULT_NOTIFICATION_PREFERENCES;
  try {
    return normalizePreferences(JSON.parse(row.value));
  } catch {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }
}

export async function saveNotificationPreferences(input: Partial<NotificationPreferences>, db: Db = getDb(), tenantId?: number | null): Promise<NotificationPreferences> {
  const current = await readNotificationPreferences(db, tenantId);
  const next = normalizePreferences({
    ...current,
    ...input,
    outlets: {
      ...current.outlets,
      ...(input.outlets ?? {}),
    },
  });
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `, preferenceKey(tenantId), JSON.stringify(next));
  return next;
}

export async function createNotificationRecord(db: Db, input: NotificationRecordInput): Promise<NotificationRecord> {
  await ensureNotificationTables(db);
  const result = await db.run(`
    INSERT INTO notification_records (tenant_id, type, title, body, source, outlet, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, input.tenantId, input.type, input.title, input.body, input.source ?? null, input.outlet ?? null, JSON.stringify(input.metadata ?? {}));
  return await db.get(`SELECT * FROM notification_records WHERE id = ?`, result.lastInsertRowid) as NotificationRecord;
}

function encodeNotificationCursor(record: NotificationRecord): string {
  return `${record.created_at}|${record.id}`;
}

function parseNotificationCursor(cursor?: string | null): { createdAt: string; id: number } | null {
  if (!cursor || typeof cursor !== 'string') return null;
  const separatorIndex = cursor.lastIndexOf('|');
  if (separatorIndex <= 0) return null;
  const createdAt = cursor.slice(0, separatorIndex);
  const id = Number(cursor.slice(separatorIndex + 1));
  if (!createdAt || !Number.isInteger(id) || id <= 0) return null;
  return { createdAt, id };
}

export async function listNotificationRecordsPage(
  db: Db,
  tenantId: number,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<NotificationPage> {
  await ensureNotificationTables(db);
  const limit = options.limit ?? 50;
  const safeLimit = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const parsedCursor = parseNotificationCursor(options.cursor);
  const pageSize = safeLimit + 1;
  const records = parsedCursor
    ? await db.all(`
      SELECT *
      FROM notification_records
      WHERE tenant_id = ?
        AND (
          datetime(created_at) < datetime(?)
          OR (datetime(created_at) = datetime(?) AND id < ?)
        )
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `, tenantId, parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id, pageSize) as NotificationRecord[]
    : await db.all(`
      SELECT *
      FROM notification_records
      WHERE tenant_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `, tenantId, pageSize) as NotificationRecord[];

  const visibleRecords = records.slice(0, safeLimit);
  const nextRecord = records.length > safeLimit ? visibleRecords[visibleRecords.length - 1] : null;
  return {
    records: visibleRecords,
    nextCursor: nextRecord ? encodeNotificationCursor(nextRecord) : null,
    limit: safeLimit,
  };
}

export async function listNotificationRecords(db: Db, tenantId: number, limit = 50): Promise<NotificationRecord[]> {
  return (await listNotificationRecordsPage(db, tenantId, { limit })).records;
}

export async function unreadNotificationCount(db: Db, tenantId: number): Promise<number> {
  await ensureNotificationTables(db);
  const row = await db.get(`
    SELECT COUNT(*) AS n
    FROM notification_records
    WHERE tenant_id = ?
  `, tenantId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export async function notificationTenantIdFromRequest(db: Db, req: Request): Promise<number> {
  return await resolveTenantIdFromRequest(db, req);
}
