import { apiFetch } from './http';
import type {
  AgentRuntimeConfig,
  AgentRuntimeType,
  InstanceRuntimeView,
  RuntimeDriverDiagnostic,
} from './types';

export const runtimesClient = {
  diagnoseRuntimeDriver: (data: {
    agent_id?: number;
    runtime_type?: AgentRuntimeType;
    runtime_config?: AgentRuntimeConfig | null;
    workspace_path?: string | null;
  }) => apiFetch<RuntimeDriverDiagnostic>('/api/v1/runtime-drivers/diagnose', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  getInstanceRuntime: (id: number) =>
    apiFetch<InstanceRuntimeView>(`/api/v1/instances/${id}/runtime`),
};
