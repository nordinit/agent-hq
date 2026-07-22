import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerExternalTaskEventTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_list_external_task_event_receipts', 'atlas_list_external_task_event_receipts'],
    'List external task-event receipts for tasks in the MCP agent assigned project and tenant. This is the project-scoped non-admin management surface for inspecting received workflow-event callbacks; it does not post callbacks, mutate mappings, or allow cross-project/cross-tenant access.',
    {
      task_id: z.number().int().positive().optional().describe('Optional task ID filter inside the assigned project'),
      source: z.string().min(1).optional().describe('Optional external event source filter'),
      event: z.string().min(1).optional().describe('Optional external event name filter'),
      processing_state: z.enum(['received', 'processed', 'rejected', 'duplicate']).optional().describe('Optional receipt processing-state filter'),
      limit: z.number().int().positive().max(200).optional().describe('Maximum receipts to return, default 50 and maximum 200'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
    },
    (args) => wrap(() => api.listExternalTaskEventReceipts(args))(),
    { domain: 'external_task_events', rest_paths: ['/api/v1/external/task-events/receipts'] },
  );

  registerTool(
    ['agent_hq_get_external_task_event_receipt', 'atlas_get_external_task_event_receipt'],
    'Get one external task-event receipt by ID, limited to tasks in the MCP agent assigned project and tenant. Out-of-project or cross-tenant receipts are denied or hidden from scoped non-admin credentials.',
    {
      receipt_id: z.number().int().positive().describe('External task-event receipt ID'),
    },
    ({ receipt_id }) => wrap(() => api.getExternalTaskEventReceipt(receipt_id))(),
    { domain: 'external_task_events', rest_paths: ['/api/v1/external/task-events/receipts/:receiptId'] },
  );
}
