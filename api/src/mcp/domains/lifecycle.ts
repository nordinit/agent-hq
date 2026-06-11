import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerLifecycleTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_add_task_note', 'atlas_add_task_note'],
    'Add a note or comment to a task.',
    {
      task_id: z.number().int().positive().describe('Task ID (required)'),
      content: z.string().min(1).describe('Note content (required)'),
      author: z.string().optional().describe('Author label (default: mcp-client)'),
    },
    ({ task_id, content, author }) => wrap(() => api.addTaskNote(task_id, content, author ?? 'mcp-client'))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/tasks/:id/notes'] },
  );
  
  registerTool(
    ['agent_hq_start_task_run', 'atlas_start_task_run'],
    'Mark the active dispatched Agent HQ run as started and register its session key. Preferred over hand-built HTTP JSON for lifecycle start callbacks.',
    {
      instance_id: z.number().int().positive().describe('Dispatched run instance ID'),
      session_key: z.string().optional().describe('Optional runtime session key for the run'),
      summary: z.string().optional().describe('Optional start summary'),
      notes: z.string().optional().describe('Optional notes for the start callback'),
    },
    ({ instance_id, ...payload }) => wrap(() => api.startInstance(instance_id, payload))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/instances/:id/start'] },
  );
  
  registerTool(
    ['agent_hq_check_in_task_run', 'atlas_check_in_task_run'],
    'Post a heartbeat or meaningful progress check-in for the active dispatched Agent HQ run.',
    {
      instance_id: z.number().int().positive().describe('Dispatched run instance ID'),
      stage: z.enum(['heartbeat', 'progress']).describe('Lifecycle check-in stage'),
      summary: z.string().optional().describe('Short truthful progress summary'),
      session_key: z.string().optional().describe('Optional runtime session key for the run'),
      meaningful_output: z.boolean().optional().describe('Whether the check-in reflects meaningful output'),
      details: z.record(z.string(), z.unknown()).optional().describe('Optional structured details for the check-in'),
    },
    ({ instance_id, ...payload }) => wrap(() => api.checkInInstance(instance_id, payload))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/instances/:id/check-in'] },
  );
  
  registerTool(
    ['agent_hq_report_task_blocker', 'atlas_report_task_blocker'],
    'Report that the active dispatched Agent HQ run is blocked. Preferred over hand-built HTTP JSON for blocker lifecycle writes.',
    {
      instance_id: z.number().int().positive().describe('Dispatched run instance ID'),
      summary: z.string().min(1).describe('Short truthful blocker summary'),
      blocker_reason: z.string().min(1).describe('Exact blocker reason'),
      session_key: z.string().optional().describe('Optional runtime session key for the run'),
      meaningful_output: z.boolean().optional().describe('Whether the blocker check-in reflects meaningful output'),
      details: z.record(z.string(), z.unknown()).optional().describe('Optional structured blocker details'),
    },
    ({ instance_id, summary, blocker_reason, session_key, meaningful_output, details }) => wrap(() => api.checkInInstance(instance_id, {
      stage: 'blocker',
      summary,
      blocker_reason,
      session_key,
      meaningful_output,
      details,
    }))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/instances/:id/check-in'] },
  );
  
  registerTool(
    ['agent_hq_record_review_evidence', 'atlas_record_review_evidence'],
    'Record review handoff evidence for a task without hand-building JSON.',
    {
      task_id: z.number().int().positive().describe('Task ID'),
      review_branch: z.string().min(1).describe('Reviewed branch name'),
      review_commit: z.string().min(1).describe('Reviewed commit SHA'),
      review_url: z.string().optional().describe('Optional review or Dev URL'),
      summary: z.string().optional().describe('Optional review handoff summary'),
    },
    ({ task_id, ...payload }) => wrap(() => api.recordReviewEvidence(task_id, payload))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/tasks/:id/review-evidence'] },
  );
  
  registerTool(
    ['agent_hq_record_qa_evidence', 'atlas_record_qa_evidence'],
    'Record QA verification evidence for a task without hand-building JSON.',
    {
      task_id: z.number().int().positive().describe('Task ID'),
      qa_verified_commit: z.string().min(1).describe('Verified commit SHA'),
      qa_tested_url: z.string().optional().describe('Optional tested URL'),
      notes: z.string().optional().describe('Optional QA notes'),
    },
    ({ task_id, ...payload }) => wrap(() => api.recordQaEvidence(task_id, payload))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/tasks/:id/qa-evidence'] },
  );
  
  registerTool(
    ['agent_hq_record_deploy_evidence', 'atlas_record_deploy_evidence'],
    'Record deploy evidence for a task without hand-building JSON.',
    {
      task_id: z.number().int().positive().describe('Task ID'),
      merged_commit: z.string().optional().describe('Optional merged commit SHA'),
      deployed_commit: z.string().min(1).describe('Deployed commit SHA'),
      deploy_target: z.string().min(1).describe('Deploy target, for example production'),
      deployed_at: z.string().optional().describe('Optional deploy timestamp'),
      summary: z.string().optional().describe('Optional deploy summary'),
    },
    ({ task_id, ...payload }) => wrap(() => api.recordDeployEvidence(task_id, payload))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/tasks/:id/deploy-evidence'] },
  );
  
  registerTool(
    ['agent_hq_record_live_verification', 'atlas_record_live_verification'],
    'Record live verification evidence for a task without hand-building JSON.',
    {
      task_id: z.number().int().positive().describe('Task ID'),
      live_verified_by: z.string().min(1).describe('Verifier identity'),
      live_verified_at: z.string().optional().describe('Optional verification timestamp'),
      summary: z.string().optional().describe('Optional live verification summary'),
    },
    ({ task_id, ...payload }) => wrap(() => api.recordLiveVerification(task_id, payload))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/tasks/:id/live-verification'] },
  );
  
  registerTool(
    ['agent_hq_post_task_outcome', 'atlas_post_task_outcome'],
    'Post a task outcome for the active run owned by this MCP key. Put workflow-specific evidence fields in payload.',
    {
      task_id: z.number().int().positive().describe('Task ID'),
      outcome: z.string().min(1).describe('Outcome key to apply'),
      summary: z.string().optional().describe('Truthful outcome summary'),
      payload: z.record(z.string(), z.unknown()).optional().describe('Workflow-specific evidence and dynamic outcome fields'),
      dry_run: z.boolean().optional().describe('Preview configured outcome validation, evidence gates, and status changes without writing task state, notes, history, receipts, or instance state'),
    },
    ({ task_id, ...payload }) => wrap(() => api.postTaskOutcome(task_id, payload))(),
    { domain: 'lifecycle', rest_paths: ['/api/v1/tasks/:id/outcome'] },
  );
}
