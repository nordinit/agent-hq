import Database from 'better-sqlite3';
import type { MaterializationResult } from '../runtimes/skillMaterialization';
import { recordSkillMaterializationIssues } from './skillMaterializationNotifications';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

async function makeDb(): Promise<Db> {
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '');
    INSERT INTO tenants (id, name) VALUES (1, 'Default');
  `);
  return db;
}

function baseContext() {
  return {
    runtimeType: 'hermes',
    agentId: 114,
    agentName: 'Vega (Frontend)',
    instanceId: 9001,
    taskId: 42,
    tenantId: 1,
    requestedSkillNames: ['ui-ux-pro-max-skill'],
  };
}

function okResult(): MaterializationResult {
  return {
    ok: true,
    count: 1,
    details: [{ skill: 'ui-ux-pro-max-skill', action: 'created' }],
    warnings: [],
  };
}

async function listRecords(db: Db) {
  return await db.all(`SELECT * FROM notification_records ORDER BY id`) as Array<{
    tenant_id: number;
    type: string;
    title: string;
    body: string;
    source: string | null;
    metadata_json: string;
  }>;
}

describe('recordSkillMaterializationIssues', () => {
  it('does not record a notification for a fully successful materialization', async () => {
    const db = await makeDb();
    expect(await recordSkillMaterializationIssues(db, okResult(), baseContext())).toBe(false);
  });

  it('does not treat benign already-correct skips as failures', async () => {
    const db = await makeDb();
    const result: MaterializationResult = {
      ok: true,
      count: 1,
      details: [{ skill: 'ui-ux-pro-max-skill', action: 'skipped', reason: 'already correct' }],
      warnings: [],
    };
    expect(await recordSkillMaterializationIssues(db, result, baseContext())).toBe(false);
  });

  it('records a notification when a skill has no resolvable source', async () => {
    const db = await makeDb();
    const result: MaterializationResult = {
      ok: true,
      count: 0,
      details: [{ skill: 'ui-ux-pro-max-skill', action: 'skipped', reason: 'source not found' }],
      warnings: ['[hermes] skill "ui-ux-pro-max-skill" not found in system path or DB — skipping'],
    };

    expect(await recordSkillMaterializationIssues(db, result, baseContext())).toBe(true);

    const records = await listRecords(db);
    expect(records).toHaveLength(1);
    expect(records[0].tenant_id).toBe(1);
    expect(records[0].type).toBe('skill_materialization_failure');
    expect(records[0].source).toBe('dispatcher');
    expect(records[0].body).toContain('ui-ux-pro-max-skill');
    expect(records[0].body).toContain('Instance #9001 · Task #42');
    const metadata = JSON.parse(records[0].metadata_json);
    expect(metadata.unresolvedSkills).toEqual(['ui-ux-pro-max-skill']);
    expect(metadata.agentId).toBe(114);
  });

  it('records a notification for per-skill materialization errors', async () => {
    const db = await makeDb();
    const result: MaterializationResult = {
      ok: true,
      count: 0,
      details: [{ skill: 'ui-ux-pro-max-skill', action: 'error', reason: 'EACCES: permission denied' }],
      warnings: ['[hermes] skill "ui-ux-pro-max-skill" materialization error: EACCES: permission denied'],
    };

    expect(await recordSkillMaterializationIssues(db, result, baseContext())).toBe(true);
    const metadata = JSON.parse((await listRecords(db))[0].metadata_json);
    expect(metadata.erroredSkills).toEqual(['ui-ux-pro-max-skill']);
  });

  it('records a notification for fatal materialization failures', async () => {
    const db = await makeDb();
    const result: MaterializationResult = {
      ok: false,
      count: 0,
      details: [],
      warnings: [],
      error: 'Failed to create skills dir /nope: EACCES',
    };

    expect(await recordSkillMaterializationIssues(db, result, baseContext())).toBe(true);
    expect((await listRecords(db))[0].body).toContain('Failed to create skills dir');
  });

  it('records a notification when requested skills are skipped entirely', async () => {
    const db = await makeDb();
    const result: MaterializationResult = {
      ok: true,
      count: 0,
      details: [],
      warnings: ['[hermes] skillsBasePath is not set and no DB provided — skipping skill materialization'],
    };

    expect(await recordSkillMaterializationIssues(db, result, baseContext())).toBe(true);
    const metadata = JSON.parse((await listRecords(db))[0].metadata_json);
    expect(metadata.requestedSkills).toEqual(['ui-ux-pro-max-skill']);
  });

  it('does not record anything when no skills were requested', async () => {
    const db = await makeDb();
    const result: MaterializationResult = { ok: true, count: 0, details: [], warnings: [] };
    expect(await recordSkillMaterializationIssues(db, result, { ...baseContext(), requestedSkillNames: [] })).toBe(false);
  });
});
