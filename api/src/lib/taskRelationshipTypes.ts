import {
  STARTER_RELATIONSHIP_TYPE_SEEDS,
  STARTER_WORKFLOW_TYPE_SEEDS,
} from './starterCatalog';
import { type Db } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

async function tableExists(db: Db, table: string): Promise<boolean> {
    return await sharedTableExists(db, table);
}

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

async function pruneUnexpectedStarterRelationshipTypes(
  db: Db,
  workflowTypeKey: string,
  options: { tenantId?: number | null; relationshipTypesHasTenantId: boolean },
): Promise<void> {
  const allowedKeys = STARTER_RELATIONSHIP_TYPE_SEEDS
    .filter((seed) => seed.workflowTypes.includes(workflowTypeKey as typeof seed.workflowTypes[number]))
    .map((seed) => seed.key);
  if (allowedKeys.length === 0) return;

  const tenantSql = options.relationshipTypesHasTenantId ? ' AND tenant_id = ?' : '';
  const tenantParams = options.relationshipTypesHasTenantId ? [options.tenantId] : [];
  await db.run(`
    DELETE FROM workflow_type_relationship_types
    WHERE workflow_type_key = ?
      ${tenantSql}
      AND COALESCE(is_system, 0) = 1
      AND key NOT IN (${allowedKeys.map(() => '?').join(', ')})
  `, workflowTypeKey, ...tenantParams, ...allowedKeys);
}

export async function pruneUnexpectedStarterWorkflowRelationshipTypes(
  db: Db,
  options: { tenantId?: number | null } = {},
): Promise<void> {
  if (!await tableExists(db, 'workflow_type_relationship_types') || !await tableExists(db, 'workflow_types')) return;

  const relationshipTypesHasTenantId = await tableHasColumn(db, 'workflow_type_relationship_types', 'tenant_id');
  const workflowTypesHasTenantId = await tableHasColumn(db, 'workflow_types', 'tenant_id');
  const tenantId = options.tenantId ?? null;
  if (relationshipTypesHasTenantId && (!Number.isInteger(tenantId) || Number(tenantId) <= 0)) return;

  const starterKeys = STARTER_WORKFLOW_TYPE_SEEDS.map((starter) => starter.key);
  const workflowTypes = workflowTypesHasTenantId && Number.isInteger(tenantId) && Number(tenantId) > 0
    ? await db.all(`
      SELECT key
      FROM workflow_types
      WHERE tenant_id = ?
        AND key IN (${starterKeys.map(() => '?').join(', ')})
      ORDER BY key ASC
    `, tenantId, ...starterKeys) as Array<{ key: string }>
    : await db.all(`
      SELECT key
      FROM workflow_types
      WHERE key IN (${starterKeys.map(() => '?').join(', ')})
      ORDER BY key ASC
    `, ...starterKeys) as Array<{ key: string }>;

  await db.withTransaction(async (db) => {
    for (const workflowType of workflowTypes) {
      await pruneUnexpectedStarterRelationshipTypes(db, workflowType.key, {
                tenantId,
                relationshipTypesHasTenantId,
              });
    }
  });
}

export async function seedStarterWorkflowRelationshipTypes(
  db: Db,
  options: { tenantId?: number | null } = {},
): Promise<void> {
  if (!await tableExists(db, 'workflow_type_relationship_types') || !await tableExists(db, 'workflow_types')) return;

  const relationshipTypesHasTenantId = await tableHasColumn(db, 'workflow_type_relationship_types', 'tenant_id');
  const workflowTypesHasTenantId = await tableHasColumn(db, 'workflow_types', 'tenant_id');
  const tenantId = options.tenantId ?? null;
  if (relationshipTypesHasTenantId && (!Number.isInteger(tenantId) || Number(tenantId) <= 0)) return;

  const starterKeys = STARTER_WORKFLOW_TYPE_SEEDS.map((starter) => starter.key);
  const workflowTypes = workflowTypesHasTenantId && Number.isInteger(tenantId) && Number(tenantId) > 0
    ? await db.all(`
      SELECT key
      FROM workflow_types
      WHERE tenant_id = ?
        AND key IN (${starterKeys.map(() => '?').join(', ')})
      ORDER BY key ASC
    `, tenantId, ...starterKeys) as Array<{ key: string }>
    : await db.all(`
      SELECT key
      FROM workflow_types
      WHERE key IN (${starterKeys.map(() => '?').join(', ')})
      ORDER BY key ASC
    `, ...starterKeys) as Array<{ key: string }>;

  const insertRelationshipTypeSql = relationshipTypesHasTenantId
    ? `
      INSERT INTO workflow_type_relationship_types (
        tenant_id, workflow_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}') ON CONFLICT DO NOTHING`
    : `
      INSERT INTO workflow_type_relationship_types (
        workflow_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}') ON CONFLICT DO NOTHING`;

  await db.withTransaction(async (db) => {
    for (const workflowType of workflowTypes) {
      await pruneUnexpectedStarterRelationshipTypes(db, workflowType.key, {
                tenantId,
                relationshipTypesHasTenantId,
              });
      for (const seed of STARTER_RELATIONSHIP_TYPE_SEEDS) {
        if (!seed.workflowTypes.includes(workflowType.key as typeof seed.workflowTypes[number])) continue;
        const params = [
          workflowType.key,
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
          await db.run(insertRelationshipTypeSql, tenantId, ...params);
        } else {
          await db.run(insertRelationshipTypeSql, ...params);
        }
      }
    }
  });
}
