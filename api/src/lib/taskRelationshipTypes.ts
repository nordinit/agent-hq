import type Database from 'better-sqlite3';
import {
  STARTER_RELATIONSHIP_TYPE_SEEDS,
  STARTER_SPRINT_TYPE_SEEDS,
} from './starterCatalog';

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(table) as { name?: string } | undefined)?.name);
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

function pruneUnexpectedStarterRelationshipTypes(
  db: Database.Database,
  sprintTypeKey: string,
  options: { tenantId?: number | null; relationshipTypesHasTenantId: boolean },
): void {
  const allowedKeys = STARTER_RELATIONSHIP_TYPE_SEEDS
    .filter((seed) => seed.sprintTypes.includes(sprintTypeKey as typeof seed.sprintTypes[number]))
    .map((seed) => seed.key);
  if (allowedKeys.length === 0) return;

  const tenantSql = options.relationshipTypesHasTenantId ? ' AND tenant_id = ?' : '';
  const tenantParams = options.relationshipTypesHasTenantId ? [options.tenantId] : [];
  db.prepare(`
    DELETE FROM sprint_type_relationship_types
    WHERE sprint_type_key = ?
      ${tenantSql}
      AND COALESCE(is_system, 0) = 1
      AND key NOT IN (${allowedKeys.map(() => '?').join(', ')})
  `).run(sprintTypeKey, ...tenantParams, ...allowedKeys);
}

export function pruneUnexpectedStarterWorkflowRelationshipTypes(
  db: Database.Database,
  options: { tenantId?: number | null } = {},
): void {
  if (!tableExists(db, 'sprint_type_relationship_types') || !tableExists(db, 'sprint_types')) return;

  const relationshipTypesHasTenantId = tableHasColumn(db, 'sprint_type_relationship_types', 'tenant_id');
  const sprintTypesHasTenantId = tableHasColumn(db, 'sprint_types', 'tenant_id');
  const tenantId = options.tenantId ?? null;
  if (relationshipTypesHasTenantId && (!Number.isInteger(tenantId) || Number(tenantId) <= 0)) return;

  const starterKeys = STARTER_SPRINT_TYPE_SEEDS.map((starter) => starter.key);
  const sprintTypes = sprintTypesHasTenantId && Number.isInteger(tenantId) && Number(tenantId) > 0
    ? db.prepare(`
      SELECT key
      FROM sprint_types
      WHERE tenant_id = ?
        AND key IN (${starterKeys.map(() => '?').join(', ')})
      ORDER BY key ASC
    `).all(tenantId, ...starterKeys) as Array<{ key: string }>
    : db.prepare(`
      SELECT key
      FROM sprint_types
      WHERE key IN (${starterKeys.map(() => '?').join(', ')})
      ORDER BY key ASC
    `).all(...starterKeys) as Array<{ key: string }>;

  const tx = db.transaction(() => {
    for (const sprintType of sprintTypes) {
      pruneUnexpectedStarterRelationshipTypes(db, sprintType.key, {
        tenantId,
        relationshipTypesHasTenantId,
      });
    }
  });
  tx();
}

export function seedStarterWorkflowRelationshipTypes(
  db: Database.Database,
  options: { tenantId?: number | null } = {},
): void {
  if (!tableExists(db, 'sprint_type_relationship_types') || !tableExists(db, 'sprint_types')) return;

  const relationshipTypesHasTenantId = tableHasColumn(db, 'sprint_type_relationship_types', 'tenant_id');
  const sprintTypesHasTenantId = tableHasColumn(db, 'sprint_types', 'tenant_id');
  const tenantId = options.tenantId ?? null;
  if (relationshipTypesHasTenantId && (!Number.isInteger(tenantId) || Number(tenantId) <= 0)) return;

  const starterKeys = STARTER_SPRINT_TYPE_SEEDS.map((starter) => starter.key);
  const sprintTypes = sprintTypesHasTenantId && Number.isInteger(tenantId) && Number(tenantId) > 0
    ? db.prepare(`
      SELECT key
      FROM sprint_types
      WHERE tenant_id = ?
        AND key IN (${starterKeys.map(() => '?').join(', ')})
      ORDER BY key ASC
    `).all(tenantId, ...starterKeys) as Array<{ key: string }>
    : db.prepare(`
      SELECT key
      FROM sprint_types
      WHERE key IN (${starterKeys.map(() => '?').join(', ')})
      ORDER BY key ASC
    `).all(...starterKeys) as Array<{ key: string }>;

  const insertRelationshipType = db.prepare(relationshipTypesHasTenantId
    ? `
      INSERT OR IGNORE INTO sprint_type_relationship_types (
        tenant_id, sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}')
    `
    : `
      INSERT OR IGNORE INTO sprint_type_relationship_types (
        sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}')
    `);

  const seedTx = db.transaction(() => {
    for (const sprintType of sprintTypes) {
      pruneUnexpectedStarterRelationshipTypes(db, sprintType.key, {
        tenantId,
        relationshipTypesHasTenantId,
      });
      for (const seed of STARTER_RELATIONSHIP_TYPE_SEEDS) {
        if (!seed.sprintTypes.includes(sprintType.key as typeof seed.sprintTypes[number])) continue;
        const params = [
          sprintType.key,
          seed.key,
          seed.label,
          seed.inverse_label,
          seed.category,
          seed.affects_dispatch_eligibility,
          seed.direction_semantics,
          seed.active_statuses_json,
          seed.resolved_statuses_json,
          seed.allow_create_related_task,
          seed.default_related_task_type,
          seed.default_related_task_status,
        ];
        if (relationshipTypesHasTenantId) {
          insertRelationshipType.run(tenantId, ...params);
        } else {
          insertRelationshipType.run(...params);
        }
      }
    }
  });
  seedTx();
}
