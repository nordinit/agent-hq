import type Database from 'better-sqlite3';

export interface TaskFieldDefinition {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
  help_text?: string;
  system?: boolean;
}

export interface ResolvedTaskFieldSchema {
  sprint_type: string;
  schema: { fields: TaskFieldDefinition[] };
  allowed_task_types: string[];
}

const ALLOWED_TASK_FIELD_TYPES = new Set(['text', 'textarea', 'url', 'select', 'number', 'checkbox']);

function normalizeSprintType(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : 'generic';
}

function normalizeTaskType(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function normalizeOptionalText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function normalizeBooleanInt(raw: unknown): number {
  return raw === true || raw === 1 || raw === '1' ? 1 : 0;
}

export function normalizeConfigKey(raw: unknown, fieldName: string): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) throw new Error(`${fieldName} is required`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error(`${fieldName} must use lowercase letters, numbers, underscores, or hyphens`);
  }
  return value;
}

export function parseMetadataObject(raw: unknown, fieldName: string): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(fieldName);
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error(`${fieldName} must be a JSON object`);
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  throw new Error(`${fieldName} must be an object`);
}

export function parseStringArray(raw: unknown, fieldName: string): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`${fieldName}[${index}] must be a non-empty string`);
      }
      return item.trim();
    });
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parseStringArray(parsed, fieldName);
    } catch {
      throw new Error(`${fieldName} must be an array of strings`);
    }
  }
  throw new Error(`${fieldName} must be an array of strings`);
}

export function parseFieldSchema(raw: unknown): { fields: TaskFieldDefinition[] } {
  const source = raw === undefined ? {} : raw;
  const parsed = parseMetadataObject(source, 'schema');
  const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
  const normalizedFields = fields.map((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error(`schema.fields[${index}] must be an object`);
    }

    const fieldRecord = field as Record<string, unknown>;
    const key = normalizeConfigKey(fieldRecord.key, `schema.fields[${index}].key`);

    const label = normalizeOptionalText(fieldRecord.label) || key;
    const type = normalizeOptionalText(fieldRecord.type) || 'text';
    if (!ALLOWED_TASK_FIELD_TYPES.has(type)) {
      throw new Error(`schema.fields[${index}].type is invalid`);
    }

    const optionsRaw = fieldRecord.options;
    const options = Array.isArray(optionsRaw)
      ? optionsRaw.map((option, optionIndex) => {
          const value = normalizeOptionalText(option);
          if (!value) throw new Error(`schema.fields[${index}].options[${optionIndex}] cannot be empty`);
          return value;
        })
      : undefined;

    if (type === 'select' && (!options || options.length === 0)) {
      throw new Error(`schema.fields[${index}].options is required for select fields`);
    }

    return {
      key,
      label,
      type,
      required: normalizeBooleanInt(fieldRecord.required) === 1,
      options,
      help_text: normalizeOptionalText(fieldRecord.help_text),
      system: normalizeBooleanInt(fieldRecord.system) === 1,
    } satisfies TaskFieldDefinition;
  });

  const uniqueKeys = new Set<string>();
  for (const field of normalizedFields) {
    if (uniqueKeys.has(field.key)) throw new Error(`Duplicate field key "${field.key}" in schema`);
    uniqueKeys.add(field.key);
  }

  return { fields: normalizedFields };
}

function parseFieldSchemaJson(raw: string | null | undefined): { fields: TaskFieldDefinition[] } {
  try {
    return parseFieldSchema(JSON.parse(raw || '{}'));
  } catch {
    return { fields: [] };
  }
}

function mergeFieldSchemas(
  defaultSchema: { fields: TaskFieldDefinition[] },
  taskTypeSchema: { fields: TaskFieldDefinition[] },
): { fields: TaskFieldDefinition[] } {
  const fields: TaskFieldDefinition[] = [...defaultSchema.fields];
  const indexes = new Map(fields.map((field, index) => [field.key, index]));

  for (const field of taskTypeSchema.fields) {
    const existingIndex = indexes.get(field.key);
    if (existingIndex === undefined) {
      indexes.set(field.key, fields.length);
      fields.push(field);
      continue;
    }
    fields[existingIndex] = field;
  }

  return { fields };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  try {
    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

export function resolveSprintTypeForSprintId(db: Database.Database, sprintId: unknown): string {
  if (sprintId == null || sprintId === '') return 'generic';

  try {
    const row = db.prepare(`SELECT sprint_type FROM sprints WHERE id = ? LIMIT 1`).get(Number(sprintId)) as { sprint_type?: string | null } | undefined;
    return normalizeSprintType(row?.sprint_type);
  } catch {
    return 'generic';
  }
}

export function getAllowedTaskTypesForSprintType(db: Database.Database, sprintType: string): string[] {
  try {
    const rows = db.prepare(`
      SELECT task_type
      FROM sprint_type_task_types
      WHERE sprint_type_key = ?
      ORDER BY task_type ASC
    `).all(normalizeSprintType(sprintType)) as Array<{ task_type: string | null }>;

    return rows
      .map(row => normalizeTaskType(row.task_type))
      .filter((taskType): taskType is string => Boolean(taskType));
  } catch {
    return [];
  }
}

export function isTaskTypeAllowedForSprintType(
  db: Database.Database,
  sprintType: string,
  taskType: unknown,
): boolean {
  const normalizedTaskType = normalizeTaskType(taskType);
  if (!normalizedTaskType) return true;

  const allowedTaskTypes = getAllowedTaskTypesForSprintType(db, sprintType);
  if (allowedTaskTypes.length === 0) return true;

  return allowedTaskTypes.includes(normalizedTaskType);
}

export function resolveTaskFieldSchemaForSprint(
  db: Database.Database,
  input: { sprintId?: unknown; sprintType?: unknown; taskType?: unknown },
): ResolvedTaskFieldSchema {
  const sprintType = input.sprintType != null
    ? normalizeSprintType(input.sprintType)
    : resolveSprintTypeForSprintId(db, input.sprintId ?? null);
  const taskType = normalizeTaskType(input.taskType);
  const allowedTaskTypes = getAllowedTaskTypesForSprintType(db, sprintType);

  if (!tableExists(db, 'task_field_schemas')) {
    return { sprint_type: sprintType, schema: { fields: [] }, allowed_task_types: allowedTaskTypes };
  }

  try {
    const getSchemaForTaskType = (candidateTaskType: string | null): { fields: TaskFieldDefinition[] } => {
      const row = db.prepare(`
        SELECT schema_json
        FROM task_field_schemas
        WHERE sprint_type_key = ?
          AND (task_type = ? OR (task_type IS NULL AND ? IS NULL))
        ORDER BY COALESCE(updated_at, created_at, datetime('now')) DESC, id DESC
        LIMIT 1
      `).get(sprintType, candidateTaskType, candidateTaskType) as { schema_json: string } | undefined;
      return row ? parseFieldSchemaJson(row.schema_json) : { fields: [] };
    };

    const defaultSchema = getSchemaForTaskType(null);
    const taskTypeSchema = taskType ? getSchemaForTaskType(taskType) : { fields: [] };
    return {
      sprint_type: sprintType,
      schema: mergeFieldSchemas(defaultSchema, taskTypeSchema),
      allowed_task_types: allowedTaskTypes,
    };
  } catch {
    return { sprint_type: sprintType, schema: { fields: [] }, allowed_task_types: allowedTaskTypes };
  }
}

export function getCustomFieldDefinitions(fields: TaskFieldDefinition[]): TaskFieldDefinition[] {
  return fields;
}

export function getGateRequirementFieldDefinitions(fields: TaskFieldDefinition[]): TaskFieldDefinition[] {
  return fields;
}

export function parseRequirementFieldExpression(fieldName: string): string[] {
  return fieldName
    .split('|')
    .map(field => field.trim())
    .filter(Boolean);
}

export function validateRequirementFieldExpression(
  db: Database.Database,
  input: { sprintId?: unknown; sprintType?: unknown; taskType?: unknown; fieldName?: unknown; fieldRole?: string },
): void {
  const fieldName = typeof input.fieldName === 'string' ? input.fieldName.trim() : '';
  if (!fieldName) return;

  const resolved = resolveTaskFieldSchemaForSprint(db, input);
  const allowedFields = new Set(getGateRequirementFieldDefinitions(resolved.schema.fields).map(field => field.key));
  if (allowedFields.size === 0) return;

  const unknownFields = parseRequirementFieldExpression(fieldName).filter(field => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    const err = new Error(`${input.fieldRole ?? 'field_name'} contains field(s) not defined for sprint type "${resolved.sprint_type}": ${unknownFields.join(', ')}`);
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
}

export function resolveTaskWorkflowContext(
  db: Database.Database,
  input: { sprintId?: unknown; sprintType?: unknown; taskType?: unknown },
): { sprintType: string; taskType: string | null; allowedTaskTypes: string[] } {
  const sprintType = input.sprintType != null
    ? normalizeSprintType(input.sprintType)
    : resolveSprintTypeForSprintId(db, input.sprintId ?? null);
  const taskType = normalizeTaskType(input.taskType);
  const allowedTaskTypes = getAllowedTaskTypesForSprintType(db, sprintType);

  return {
    sprintType,
    taskType,
    allowedTaskTypes,
  };
}
