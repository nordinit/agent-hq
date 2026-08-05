import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { ATLAS_SESSION_KEY, ATLAS_SYSTEM_ROLE, ensureCanonicalAtlasSessionKey } from './atlasAgent';

/**
 * A PostgreSQL install must end up with the canonical Atlas identity.
 *
 * It did not. ATLAS_SESSION_KEY is written at creation only by seedInitialData() in db/schema.ts,
 * on the raw better-sqlite3 handle, reachable only from initSchema() — so an install created on
 * PostgreSQL got a tenant-shaped key instead. Lookups tolerate that (they match system_role
 * first), but db/seed-dev.ts guards its Atlas insert on the session key, so seeding a fresh
 * PostgreSQL install would have added a SECOND Atlas to the default tenant.
 */

beforeEach(async () => { await setupTestDb(); });
afterEach(async () => { await teardownTestDb(); });

/** Creates the explicit tenant parent required by each identity case. */
async function seedTenant(isDefault = 1): Promise<number> {
  const db = getDb();
  const slug = isDefault ? 'default' : 'other';
  const existing = await db.get(`SELECT id FROM tenants WHERE slug = ?`, slug) as { id: number } | undefined;
  if (existing) return existing.id;
  await db.run(
    `INSERT INTO tenants (name, slug, is_default) VALUES (?, ?, ?)`,
    isDefault ? 'Default' : 'Other', slug, isDefault,
  );
  const row = await db.get(`SELECT id FROM tenants WHERE slug = ?`, slug) as { id: number };
  return row.id;
}

/** Removes any Atlas seeded by the case so each assertion starts from a known row set. */
async function clearAtlas(tenantId: number): Promise<void> {
  await getDb().run(`DELETE FROM agents WHERE system_role = ? AND tenant_id = ?`, ATLAS_SYSTEM_ROLE, tenantId);
}

async function seedAgent(tenantId: number, sessionKey: string, systemRole: string | null): Promise<number> {
  const db = getDb();
  await db.run(
    `INSERT INTO agents (tenant_id, name, role, session_key, workspace_path, status, system_role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    tenantId, 'Atlas', 'General Assistant', sessionKey, '/tmp/ws', 'idle', systemRole,
  );
  const row = await db.get(`SELECT id FROM agents WHERE session_key = ?`, sessionKey) as { id: number };
  return row.id;
}

describe('ensureCanonicalAtlasSessionKey', () => {
  it('renames a tenant-shaped Atlas onto the canonical key', async () => {
    const tenantId = await seedTenant();
    await clearAtlas(tenantId);
    const id = await seedAgent(tenantId, 'agent:default-default-project:atlas:general-assistant:main', ATLAS_SYSTEM_ROLE);

    expect(await ensureCanonicalAtlasSessionKey(getDb())).toBe('renamed');
    const after = await getDb().get(`SELECT session_key FROM agents WHERE id = ?`, id) as { session_key: string };
    expect(after.session_key).toBe(ATLAS_SESSION_KEY);
  });

  it('is idempotent', async () => {
    const tenantId = await seedTenant();
    await clearAtlas(tenantId);
    await seedAgent(tenantId, ATLAS_SESSION_KEY, ATLAS_SYSTEM_ROLE);
    expect(await ensureCanonicalAtlasSessionKey(getDb())).toBe('unchanged');
    expect(await ensureCanonicalAtlasSessionKey(getDb())).toBe('unchanged');
  });

  it('refuses to act when two agents already claim atlas', async () => {
    // Reconciling duplicates has real choices in it and must not happen as a side effect of
    // running migrations.
    const tenantId = await seedTenant();
    await clearAtlas(tenantId);
    await seedAgent(tenantId, 'agent:one:main', ATLAS_SYSTEM_ROLE);
    await seedAgent(tenantId, 'agent:two:main', ATLAS_SYSTEM_ROLE);
    expect(await ensureCanonicalAtlasSessionKey(getDb())).toBe('skipped');
  });

  it('refuses when another agent already holds the canonical key', async () => {
    // session_key is unique, so the rename would fail the constraint — and the row already
    // holding it is the one to look at, not to overwrite.
    const tenantId = await seedTenant();
    await clearAtlas(tenantId);
    await seedAgent(tenantId, 'agent:tenant-shaped:main', ATLAS_SYSTEM_ROLE);
    await seedAgent(tenantId, ATLAS_SESSION_KEY, null);
    expect(await ensureCanonicalAtlasSessionKey(getDb())).toBe('skipped');
  });

  it('only touches the default tenant', async () => {
    // The default tenant has no Atlas at all here, so there is nothing for the function to act
    // on — and an Atlas belonging to another tenant must not be dragged onto the shared key.
    const defaultTenant = await seedTenant();
    await clearAtlas(defaultTenant);
    const other = await seedTenant(0);
    const id = await seedAgent(other, 'agent:other:main', ATLAS_SYSTEM_ROLE);

    expect(await ensureCanonicalAtlasSessionKey(getDb())).toBe('skipped');
    const after = await getDb().get(`SELECT session_key FROM agents WHERE id = ?`, id) as { session_key: string };
    expect(after.session_key).toBe('agent:other:main');
  });
});
