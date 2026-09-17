import { z } from 'zod';
import { scopeSchema } from './access';

export const telemetryDisplaySchema = z.enum(['card', 'table', 'bar', 'line', 'funnel', 'distribution']);
export const telemetryViewSchema = z.object({
  group_by: z.array(z.unknown()).max(3).optional(),
  bucket: z.enum(['hour', 'day', 'week', 'month']).nullable().optional(),
  filter: z.unknown().optional(),
  scope: scopeSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().max(100).optional(),
  sort: z.enum(['value_desc', 'value_asc', 'label']).optional(),
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to), 'The time range must end after it starts.');
export const telemetryWidgetSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  metric_revision_id: z.string().min(1), metric_id: z.string().optional(),
  title: z.string().max(200).optional(), display: telemetryDisplaySchema.optional(),
  view: telemetryViewSchema.optional(),
  layout: z.object({ width: z.union([z.literal(4), z.literal(6), z.literal(12)]), height: z.enum(['compact', 'regular', 'tall']) }).strict().optional(),
}).strict();

export function viewDisplayIssue(definition: {time_basis: string; bucket?: string; measure: {kind: string; aggregate?: string}}, display?: string) {
  if (display === 'line' && (definition.time_basis === 'current' || !definition.bucket)) return 'A time chart requires a historical measurement and a time bucket. Current snapshots cannot show a historical trend.';
  if (display === 'funnel' && definition.measure.kind !== 'funnel') return 'A funnel chart requires a funnel measurement.';
  if (display === 'distribution' && definition.measure.aggregate !== 'distribution') return 'A distribution chart requires a distribution measurement.';
}
