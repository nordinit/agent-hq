export type CapabilityToolExecutionType = 'shell' | 'script' | 'http';

export interface CapabilityToolMetadata {
  assignmentId: number;
  toolId: number;
  name: string;
  slug: string;
  description: string;
  permissions: 'read_only' | 'read_write' | 'exec' | 'network';
  tags: string[];
}

export interface ShellExecutionDefinition {
  type: 'shell';
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ScriptExecutionDefinition {
  type: 'script';
  command?: string;
  inline?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpExecutionDefinition {
  type: 'http';
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export type CapabilityToolExecutionDefinition =
  | ShellExecutionDefinition
  | ScriptExecutionDefinition
  | HttpExecutionDefinition;

export interface MaterializedAssignedCapabilityTool {
  metadata: CapabilityToolMetadata;
  inputSchema: Record<string, unknown>;
  execution: CapabilityToolExecutionDefinition;
}

export interface OpenClawMaterializedAssignedTool {
  id: number;
  tool_id: number;
  assignment_id: number;
  name: string;
  slug: string;
  description: string;
  input_schema: Record<string, unknown>;
  tags: string[];
  permissions: CapabilityToolMetadata['permissions'];
  enabled: boolean;
  assignment_enabled: boolean;
  execution_type: CapabilityToolExecutionType;
  execution_payload: CapabilityToolExecutionDefinition;
}
