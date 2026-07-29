import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb, getRawDb } from './client';
import { initSchema } from './schema';
import { bootstrapRoutingAndWorkflowDefaults } from './bootstrapDefaults';

let tempDir = '';
let originalDbPath: string | undefined;

function rows(sql: string): unknown[] {
  return getRawDb().prepare(sql).all() as unknown[];
}

describe('API startup routing metadata and workflow-event defaults', () => {
  beforeEach(() => {
    originalDbPath = process.env.AGENT_HQ_DB_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-startup-routing-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath === undefined) {
      delete process.env.AGENT_HQ_DB_PATH;
    } else {
      process.env.AGENT_HQ_DB_PATH = originalDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves task_statuses and routing_transitions rows exactly when schema startup reruns', async () => {
    const db = getDb();
    await db.exec(`
      CREATE TABLE task_statuses (
        name                TEXT PRIMARY KEY,
        label               TEXT NOT NULL,
        color               TEXT NOT NULL DEFAULT 'slate',
        terminal            INTEGER NOT NULL DEFAULT 0,
        is_system           INTEGER NOT NULL DEFAULT 0,
        allowed_transitions TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE routing_transitions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id   INTEGER,
        from_status  TEXT NOT NULL,
        outcome      TEXT NOT NULL,
        to_status    TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        task_type    TEXT,
        priority     INTEGER NOT NULL DEFAULT 0,
        is_protected INTEGER NOT NULL DEFAULT 0
      );
    `);
    await db.run(`
      INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions)
      VALUES ('ready', 'Custom Ready', 'pink', 0, 0, '["custom_next"]')
    `);
    await db.run(`
      INSERT INTO routing_transitions (
        id, project_id, from_status, outcome, to_status, enabled, created_at, task_type, priority, is_protected
      ) VALUES (9, NULL, 'ready', 'custom_outcome', 'custom_next', 1, '2026-06-04 09:00:00', 'backend', 77, 1)
    `);

    const statusBefore = rows(`SELECT * FROM task_statuses ORDER BY name`);
    const transitionsBefore = rows(`SELECT * FROM routing_transitions ORDER BY id`);

    await initSchema();

    expect(rows(`SELECT * FROM task_statuses ORDER BY name`)).toEqual(statusBefore);
    expect(rows(`SELECT * FROM routing_transitions ORDER BY id`)).toEqual(transitionsBefore);
  });

  it('preserves customized and deleted workflow-event mappings when schema startup reruns', async () => {
    await initSchema();
    await bootstrapRoutingAndWorkflowDefaults(getDb());

    const db = getDb();
    const deleted = await db.get(`
      SELECT id
      FROM external_event_mappings
      WHERE project_id IS NULL
      ORDER BY id ASC
      LIMIT 1
    `) as { id: number };
    await db.run(`DELETE FROM external_event_mappings WHERE id = ?`, deleted.id);
    await db.run(`
      UPDATE external_event_mappings
      SET enabled = 0, priority = priority + 123, updated_at = '2026-06-04 09:15:00'
      WHERE id = (
        SELECT id
        FROM external_event_mappings
        WHERE project_id IS NULL
        ORDER BY id ASC
        LIMIT 1
      )
    `);
    await db.run(`
      INSERT INTO external_event_mappings (
        tenant_id, project_id, source, event_name, task_type,
        status_includes_json, status_excludes_json, action_kind, action_target,
        apply_review_evidence, apply_failure_detail, enabled, priority, created_at, updated_at
      ) VALUES (1, NULL, 'custom-source', 'custom-event', NULL, '[]', '[]', 'ignore', NULL, 0, 0, 1, 999, '2026-06-04 09:20:00', '2026-06-04 09:20:00')
    `);

    const before = rows(`SELECT * FROM external_event_mappings ORDER BY id`);

    await initSchema();

    expect(rows(`SELECT * FROM external_event_mappings ORDER BY id`)).toEqual(before);
  });

  it('creates routing and workflow-event defaults only through explicit bootstrap', async () => {
    await initSchema();
    expect(rows(`SELECT * FROM external_event_mappings`)).toEqual([]);

    await bootstrapRoutingAndWorkflowDefaults(getDb());

    expect(rows(`SELECT * FROM task_statuses`)).not.toEqual([]);
    expect(rows(`SELECT * FROM external_event_mappings`)).not.toEqual([]);
  });
});
