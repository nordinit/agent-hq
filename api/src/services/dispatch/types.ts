export interface CandidateTask {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  agent_id: number | null;
  tenant_id: number | null;
  project_id: number | null;
  task_type: string | null;
  workflow_id: number | null;
  workflow_name: string | null;
  workflow_type: string | null;
  created_at: string;
  blocking_count: number;
  story_points: number | null;
  active_instance_id: number | null;
}
