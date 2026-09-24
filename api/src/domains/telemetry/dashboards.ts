import { z } from 'zod';
import { scopeSchema } from './access';
import { telemetryDisplaySchema, telemetryWidgetSchema } from './views';

const identity = z.string().min(1).max(128);
export const dashboardOperationSchema = z.enum(['agents', 'active_runs', 'templates', 'runs', 'completed_runs', 'tokens', 'failed_runs', 'failures', 'completed_tasks', 'links']);
const common = {
  id: identity,
  title: z.string().max(200).optional(),
  accent: z.enum(['blue', 'amber', 'green', 'cyan', 'violet', 'red', 'neutral']).optional(),
  icon: z.enum(['activity', 'bot', 'search', 'users', 'target', 'check', 'coins', 'file', 'layers', 'clock']).optional(),
  surface: z.enum(['card', 'plain']).optional(),
};
export const dashboardBlockSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('metric'), binding_id: identity, display: telemetryDisplaySchema.optional(), precision: z.number().int().min(0).max(6).optional() }).strict(),
  z.object({ ...common, type: z.literal('comparison'), binding_ids: z.array(identity).min(1).max(10), rows: z.number().int().min(3).max(50).optional(), sort: z.enum(['label', 'value_desc', 'value_asc']).optional(), sort_by: identity.optional() }).strict(),
  z.object({ ...common, type: z.literal('operation'), operation: dashboardOperationSchema }).strict(),
  z.object({ ...common, type: z.enum(['heading', 'note', 'callout']), text: z.string().max(12000) }).strict(),
  z.object({ ...common, type: z.literal('divider') }).strict(),
  z.object({ ...common, type: z.literal('link'), url: z.string().max(2000).refine(value => /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value), 'Use an http(s) URL or a local /path.').refine(value => !/[\\\u0000-\u0020]/.test(value), 'Links cannot contain backslashes or control characters.') }).strict(),
]);
export const dashboardSchema = z.object({
  version: z.literal(1),
  description: z.string().max(2000).optional(),
  template: z.enum(['operations', 'agency', 'blank', 'imported']).optional(),
  scope: scopeSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().max(100).default('UTC'),
  appearance: z.object({ width: z.enum(['standard', 'wide']), density: z.enum(['comfortable', 'compact']) }).strict(),
  metrics: z.array(telemetryWidgetSchema.safeExtend({ id: identity })).max(10),
  sections: z.array(z.object({
    id: identity, title: z.string().max(200), collapsed: z.boolean().optional(),
    columns: z.array(z.object({ id: identity, width: z.number().int().min(1).max(12), blocks: z.array(dashboardBlockSchema).max(40) }).strict()).min(1).max(4),
  }).strict()).max(24),
}).strict().superRefine((page, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const metricIds = new Set(page.metrics.map(metric => metric.id));
  if (metricIds.size !== page.metrics.length) issue('Metric binding IDs must be unique.');
  const ids = new Set<string>(); let blocks = 0;
  const unique = (id: string) => { if (ids.has(id)) issue('Section, column, and block IDs must be unique.'); ids.add(id); };
  for (const section of page.sections) {
    unique(section.id);
    if (section.columns.reduce((sum, column) => sum + column.width, 0) !== 12) issue('Column widths in each section must add up to 12.');
    for (const column of section.columns) {
      unique(column.id);
      for (const block of column.blocks) {
        blocks++; unique(block.id);
        for (const ref of block.type === 'metric' ? [block.binding_id] : block.type === 'comparison' ? block.binding_ids : []) {
          if (!metricIds.has(ref)) issue(`Unknown metric binding: ${ref}.`);
        }
        if (block.type === 'comparison' && new Set(block.binding_ids).size !== block.binding_ids.length) issue('Comparison columns must reference different bindings.');
        if (block.type === 'comparison' && block.sort_by && !block.binding_ids.includes(block.sort_by)) issue('Sort by one of the selected comparison metrics.');
        if (block.type === 'operation' && (page.scope?.workflow_id || page.scope?.workflow_type || page.scope?.task_type)) issue('Operational blocks support project scope only.');
      }
    }
  }
  if (blocks > 80) issue('A page supports up to 80 blocks and 10 metric queries.');
  if (page.from && page.to && Date.parse(page.from) >= Date.parse(page.to)) issue('The time range must end after it starts.');
  try { new Intl.DateTimeFormat('en', { timeZone: page.timezone }).format(); } catch { issue('Use a valid IANA timezone.'); }
});
