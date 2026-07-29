import { getDb } from '../../db/client';
import {
  getCustomFieldDefinitions,
  resolveSprintTypeForSprintId,
  resolveTaskFieldSchemaForSprint,
  type TaskFieldDefinition,
} from '../sprint-definitions/config';

export const VALID_STORY_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;

export type CustomFieldDefinition = TaskFieldDefinition;

export interface ResolvedTaskFieldSchema {
  sprint_type: string;
  schema: { fields: CustomFieldDefinition[] };
  allowed_task_types: string[];
}

export function normalizeStoryPoints(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new Error('story_points must be an integer');
  if (!VALID_STORY_POINTS.includes(parsed as typeof VALID_STORY_POINTS[number])) {
    throw new Error(`Invalid story_points "${value}". Valid: ${VALID_STORY_POINTS.join(', ')}`);
  }
  return parsed;
}

export function parseCustomFields(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('custom_fields must be an object');
    }
    return parsed as Record<string, unknown>;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  throw new Error('custom_fields must be an object');
}

export async function resolveSprintTypeForTask(sprintId: unknown): Promise<string> {
  const db = getDb();
  return await resolveSprintTypeForSprintId(db, sprintId);
}

export async function resolveTaskFieldSchema(sprintId: unknown, taskType: unknown, sprintType?: unknown): Promise<ResolvedTaskFieldSchema> {
  const db = getDb();
  return await resolveTaskFieldSchemaForSprint(db, { sprintId, sprintType, taskType });
}

function customFieldValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface ValidateTaskCustomFieldsOptions {
  /** Existing persisted values. Unknown keys that are present and unchanged here are retired fields and may be preserved. */
  existingCustomFields?: Record<string, unknown>;
  /** Permit unknown keys only when they already exist and are unchanged. */
  allowUnchangedUnknownFields?: boolean;
  /** Enforce required fields from the active schema. Defaults to true for create/edit operations. */
  requireRequiredFields?: boolean;
}

export type TaskCustomFieldValidationErrorCode =
  | 'unknown_field'
  | 'required'
  | 'invalid_type'
  | 'invalid_url'
  | 'invalid_select_value'
  | 'unsupported_value';

export interface TaskCustomFieldValidationErrorDetail {
  field: string;
  code: TaskCustomFieldValidationErrorCode;
  message: string;
  expected?: string;
  allowed_values?: string[];
}

export class TaskCustomFieldValidationError extends Error {
  readonly status = 400;

  constructor(readonly validation_errors: TaskCustomFieldValidationErrorDetail[]) {
    super(validation_errors[0]?.message ?? 'Custom field validation failed');
    this.name = 'TaskCustomFieldValidationError';
  }
}

function customFieldValidationError(
  field: string,
  code: TaskCustomFieldValidationErrorCode,
  message: string,
  extra: Omit<TaskCustomFieldValidationErrorDetail, 'field' | 'code' | 'message'> = {},
): TaskCustomFieldValidationErrorDetail {
  return {
    field,
    code,
    message,
    ...extra,
  };
}

export function validateTaskCustomFields(
  customFields: Record<string, unknown>,
  schema: { fields: CustomFieldDefinition[] },
  options: ValidateTaskCustomFieldsOptions = {},
): void {
  const fields = getCustomFieldDefinitions(Array.isArray(schema.fields) ? schema.fields : []);
  const knownKeys = new Set(fields.map((field) => field.key));
  const existingCustomFields = options.existingCustomFields ?? {};
  const requireRequiredFields = options.requireRequiredFields ?? true;
  const validationErrors: TaskCustomFieldValidationErrorDetail[] = [];

  for (const key of Object.keys(customFields)) {
    if (knownKeys.has(key)) continue;
    const isUnchangedRetiredField = options.allowUnchangedUnknownFields === true
      && Object.prototype.hasOwnProperty.call(existingCustomFields, key)
      && customFieldValuesEqual(existingCustomFields[key], customFields[key]);
    if (!isUnchangedRetiredField) {
      validationErrors.push(customFieldValidationError(
        key,
        'unknown_field',
        `Unknown custom field "${key}"`,
      ));
    }
  }

  for (const field of fields) {
    const value = customFields[field.key];
    const isEmpty = value === null || value === undefined || value === '';
    if (requireRequiredFields && field.required && isEmpty) {
      validationErrors.push(customFieldValidationError(
        field.key,
        'required',
        `custom field "${field.key}" is required`,
      ));
    }
    if (isEmpty) continue;

    switch (field.type) {
      case 'textarea':
      case 'text':
      case 'url':
        if (typeof value !== 'string') {
          validationErrors.push(customFieldValidationError(
            field.key,
            'invalid_type',
            `custom field "${field.key}" must be a string`,
            { expected: 'string' },
          ));
          break;
        }
        if (field.type === 'url' && value.trim().length > 0) {
          try {
            new URL(value);
          } catch {
            validationErrors.push(customFieldValidationError(
              field.key,
              'invalid_url',
              `custom field "${field.key}" must be a valid URL`,
              { expected: 'url' },
            ));
          }
        }
        break;
      case 'select':
        if (typeof value !== 'string') {
          validationErrors.push(customFieldValidationError(
            field.key,
            'invalid_type',
            `custom field "${field.key}" must be a string`,
            { expected: 'string' },
          ));
          break;
        }
        if (Array.isArray(field.options) && field.options.length > 0 && !field.options.includes(value)) {
          validationErrors.push(customFieldValidationError(
            field.key,
            'invalid_select_value',
            `custom field "${field.key}" must be one of: ${field.options.join(', ')}`,
            { allowed_values: field.options },
          ));
        }
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          validationErrors.push(customFieldValidationError(
            field.key,
            'invalid_type',
            `custom field "${field.key}" must be a number`,
            { expected: 'number' },
          ));
        }
        break;
      case 'checkbox':
        if (typeof value !== 'boolean') {
          validationErrors.push(customFieldValidationError(
            field.key,
            'invalid_type',
            `custom field "${field.key}" must be a boolean`,
            { expected: 'boolean' },
          ));
        }
        break;
      default:
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          validationErrors.push(customFieldValidationError(
            field.key,
            'unsupported_value',
            `custom field "${field.key}" has an unsupported value`,
            { expected: 'string | number | boolean' },
          ));
        }
        break;
    }
  }

  if (validationErrors.length > 0) {
    throw new TaskCustomFieldValidationError(validationErrors);
  }
}
