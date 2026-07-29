import Database from 'better-sqlite3';
import { notifyTelegram } from '../integrations/telegram';
import { saveNotificationPreferences } from './notifications';
import { notifyTaskStatusChange } from './taskNotifications';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

jest.mock('../integrations/telegram', () => ({
  notifyTelegram: jest.fn(),
}));

async function createDb(): Promise<Db> {
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sprint_type TEXT NOT NULL DEFAULT 'generic'
    );

    CREATE TABLE sprint_types (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE task_statuses (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      title TEXT NOT NULL,
      project_id INTEGER,
      sprint_id INTEGER
    );

    CREATE TABLE sprint_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sprint_type_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT,
      from_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      to_status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sprint_task_transition_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT,
      outcome TEXT NOT NULL,
      field_name TEXT NOT NULL,
      requirement_type TEXT NOT NULL,
      match_field TEXT,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sprint_task_routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1), (5, 'Tenant 5', 'tenant-5', 0)`);
  await db.run(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ')`);
  await db.run(`INSERT INTO sprint_types (key, name, is_system) VALUES ('enhancements', 'Enhancements', 0)`);
  await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (10, 1, 'Enhancements Sprint', 'enhancements')`);

  return db;
}

async function seedTask(db: Db, taskId: number, tenantId = 1): Promise<void> {
  await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (?, ?, 'Status emoji test', 1, 10)`, taskId, tenantId);
}

async function seedSprintStatus(
  db: Db,
  statusKey: string,
  metadataJson = '{}',
  stageOrder = 0,
): Promise<void> {
  await db.run(`
    INSERT INTO sprint_task_statuses (
      sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
    ) VALUES (?, ?, ?, 'slate', 0, 0, '[]', ?, 0, ?)
  `, 10, statusKey, statusKey, stageOrder, metadataJson);
}

describe('notifyTaskStatusChange', () => {
  const notifyTelegramMock = jest.mocked(notifyTelegram);

  beforeEach(() => {
    notifyTelegramMock.mockReset();
    notifyTelegramMock.mockResolvedValue(undefined as never);
  });

  it('uses configured sprint-scoped emoji for system statuses when present', async () => {
    const db = await createDb();
    try {
      await seedTask(db, 484);
      await seedSprintStatus(db, 'in_progress', '{"emoji":"🏗️"}', 0);
      await seedSprintStatus(db, 'blocked', '{"emoji":"🧱"}', 1);

      await notifyTaskStatusChange(db, {
                taskId: 484,
                fromStatus: 'in_progress',
                toStatus: 'blocked',
                source: 'cinder-backend',
              });

      expect(notifyTelegramMock).toHaveBeenCalledWith(expect.stringContaining('🧱 <b>Task #484 — Status Changed</b>'));
      expect(notifyTelegramMock).toHaveBeenCalledWith(expect.stringContaining('🏗️ <i>in_progress</i>  →  🧱 <b>blocked</b>'));
    } finally {
      db.close();
    }
  });

  it('uses configured sprint-scoped emoji for custom sprint statuses', async () => {
    const db = await createDb();
    try {
      await seedTask(db, 485);
      await seedSprintStatus(db, 'review', '{}', 0);
      await seedSprintStatus(db, 'review_ready', '{"emoji":"🧪"}', 1);

      await notifyTaskStatusChange(db, {
                taskId: 485,
                fromStatus: 'review',
                toStatus: 'review_ready',
                source: 'cinder-backend',
              });

      expect(notifyTelegramMock).toHaveBeenCalledWith(expect.stringContaining('🧪 <b>Task #485 — Status Changed</b>'));
      expect(notifyTelegramMock).toHaveBeenCalledWith(expect.stringContaining('🔍 <i>review</i>  →  🧪 <b>review_ready</b>'));
    } finally {
      db.close();
    }
  });

  it('falls back to the canonical persisted/system emoji map when no configured emoji exists', async () => {
    const db = await createDb();
    try {
      await seedTask(db, 486);
      await seedSprintStatus(db, 'ready', '{}', 0);
      await seedSprintStatus(db, 'review', '{}', 1);

      await notifyTaskStatusChange(db, {
                taskId: 486,
                fromStatus: 'ready',
                toStatus: 'review',
                source: 'cinder-backend',
              });

      expect(notifyTelegramMock).toHaveBeenCalledWith(expect.stringContaining('🔍 <b>Task #486 — Status Changed</b>'));
      expect(notifyTelegramMock).toHaveBeenCalledWith(expect.stringContaining('🔵 <i>ready</i>  →  🔍 <b>review</b>'));
    } finally {
      db.close();
    }
  });

  it('uses canonical emoji for statuses that were missing from the old Telegram fallback map', async () => {
    const db = await createDb();
    try {
      await seedTask(db, 487);
      await seedSprintStatus(db, 'dev_deploy_queued', '{}', 0);
      await seedSprintStatus(db, 'blocked', '{}', 1);

      await notifyTaskStatusChange(db, {
                taskId: 487,
                fromStatus: 'dev_deploy_queued',
                toStatus: 'blocked',
                source: 'cinder-backend',
              });

      expect(notifyTelegramMock).toHaveBeenCalledWith(expect.stringContaining('🧱 <b>Task #487 — Status Changed</b>'));
      expect(notifyTelegramMock).toHaveBeenCalledWith(expect.stringContaining('🕒 <i>dev_deploy_queued</i>  →  🧱 <b>blocked</b>'));
    } finally {
      db.close();
    }
  });

  it('persists a notification record for status changes', async () => {
    const db = await createDb();
    try {
      await seedTask(db, 488);
      await seedSprintStatus(db, 'ready', '{}', 0);
      await seedSprintStatus(db, 'review', '{}', 1);

      await notifyTaskStatusChange(db, {
                taskId: 488,
                fromStatus: 'ready',
                toStatus: 'review',
                source: 'cinder-backend',
              });

      const row = await db.get(`SELECT title, body, source, outlet FROM notification_records WHERE type = 'task_status_change'`) as {
        title: string;
        body: string;
        source: string;
        outlet: string;
      };
      expect(row.title).toBe('🔍 Task #488 status changed');
      expect(row.body).toContain('🔵 ready -> 🔍 review');
      expect(row.body).toContain('Workflow: Enhancements Sprint');
      expect(row.body).not.toContain('Sprint: Enhancements Sprint');
      expect(row.source).toBe('cinder-backend');
      expect(row.outlet).toBe('telegram');
      expect(notifyTelegramMock).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('keeps notification history when delivery is disabled', async () => {
    const db = await createDb();
    try {
      await saveNotificationPreferences({ enabled: false }, db);
      await seedTask(db, 489);
      await seedSprintStatus(db, 'ready', '{}', 0);
      await seedSprintStatus(db, 'blocked', '{}', 1);

      await notifyTaskStatusChange(db, {
                taskId: 489,
                fromStatus: 'ready',
                toStatus: 'blocked',
                source: 'cinder-backend',
              });

      const count = (await db.get(`SELECT COUNT(*) AS n FROM notification_records WHERE type = 'task_status_change'`) as { n: number }).n;
      expect(count).toBe(1);
      expect(notifyTelegramMock).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('uses the task tenant preferences for Telegram delivery', async () => {
    const db = await createDb();
    try {
      await saveNotificationPreferences({ enabled: false }, db, 5);
      await seedTask(db, 490, 5);
      await seedSprintStatus(db, 'ready', '{}', 0);
      await seedSprintStatus(db, 'review', '{}', 1);

      await notifyTaskStatusChange(db, {
                taskId: 490,
                fromStatus: 'ready',
                toStatus: 'review',
                source: 'cinder-backend',
              });

      const row = await db.get(`SELECT tenant_id FROM notification_records WHERE type = 'task_status_change'`) as { tenant_id: number };
      expect(row.tenant_id).toBe(5);
      expect(notifyTelegramMock).not.toHaveBeenCalled();
      expect(await db.get(`SELECT value FROM app_settings WHERE key = 'notifications.preferences'`)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
