import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerProjectsTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_get_projects', 'atlas_get_projects', 'agent_hq_list_projects', 'atlas_list_projects'],
    'List Agent HQ projects with clean summary fields.',
    {},
    () => wrap(() => api.listProjects())(),
    { domain: 'projects', rest_paths: ['/api/v1/projects'] },
  );
  
  registerTool(
    ['agent_hq_get_project', 'atlas_get_project'],
    'Get a project by ID, including metrics.',
    { project_id: z.number().int().positive().describe('Project ID') },
    ({ project_id }) => wrap(() => api.getProject(project_id))(),
    { domain: 'projects', rest_paths: ['/api/v1/projects/:id'] },
  );
  
  registerTool(
    ['agent_hq_create_project', 'atlas_create_project'],
    'Create a project in Agent HQ.',
    {
      name: z.string().min(1).describe('Project name'),
      description: z.string().optional().describe('Project description'),
      context_md: z.string().optional().describe('Project context markdown'),
    },
    ({ name, description, context_md }) => wrap(() => api.createProject({ name, description, context_md }))(),
    { domain: 'projects', rest_paths: ['/api/v1/projects'] },
  );
  
  registerTool(
    ['agent_hq_update_project', 'atlas_update_project'],
    'Update a project in Agent HQ.',
    {
      project_id: z.number().int().positive().describe('Project ID'),
      name: z.string().min(1).optional().describe('Project name'),
      description: z.string().optional().describe('Project description'),
      context_md: z.string().optional().describe('Project context markdown'),
    },
    ({ project_id, name, description, context_md }) => wrap(() => api.updateProject(project_id, { name, description, context_md }))(),
    { domain: 'projects', rest_paths: ['/api/v1/projects/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_project', 'atlas_delete_project'],
    'Delete a project. Returns truthful validation errors when active work blocks deletion unless force=true is passed.',
    {
      project_id: z.number().int().positive().describe('Project ID'),
      force: z.boolean().optional().describe('Force delete even if active work exists'),
    },
    ({ project_id, force }) => wrap(() => api.deleteProject(project_id, force))(),
    { domain: 'projects', rest_paths: ['/api/v1/projects/:id'] },
  );
  
  registerTool(
    ['agent_hq_list_project_files', 'atlas_list_project_files'],
    'List files uploaded to a project. Scoped through the Agent HQ project-file API.',
    { project_id: z.number().int().positive().describe('Project ID') },
    ({ project_id }) => wrap(() => api.listProjectFiles(project_id))(),
    { domain: 'project_files', rest_paths: ['/api/v1/projects/:id/files'] },
  );
  
  registerTool(
    ['agent_hq_get_project_file', 'atlas_get_project_file'],
    'Read project-file metadata by project and file ID.',
    {
      project_id: z.number().int().positive().describe('Project ID'),
      file_id: z.number().int().positive().describe('Project file ID'),
    },
    ({ project_id, file_id }) => wrap(() => api.getProjectFile(project_id, file_id))(),
    { domain: 'project_files', rest_paths: ['/api/v1/projects/:id/files/:fileId'] },
  );

  registerTool(
    ['agent_hq_list_project_file_versions', 'atlas_list_project_file_versions'],
    'List version history for a project file, including version number, timestamp, actor, size, MIME type, and stored snapshot filename.',
    {
      project_id: z.number().int().positive().describe('Project ID'),
      file_id: z.number().int().positive().describe('Project file ID'),
    },
    ({ project_id, file_id }) => wrap(() => api.listProjectFileVersions(project_id, file_id))(),
    { domain: 'project_files', rest_paths: ['/api/v1/projects/:id/files/:fileId/versions'] },
  );
  
  registerTool(
    ['agent_hq_download_project_file', 'atlas_download_project_file'],
    'Download a project file as agent-usable base64 content, with UTF-8 text included for text-like MIME types by default.',
    {
      project_id: z.number().int().positive().describe('Project ID'),
      file_id: z.number().int().positive().describe('Project file ID'),
      include_text: z.boolean().optional().describe('Include UTF-8 text when the MIME type is text-like; defaults to true'),
    },
    ({ project_id, file_id, include_text }) => wrap(() => api.downloadProjectFile(project_id, file_id, include_text ?? true))(),
    { domain: 'project_files', rest_paths: ['/api/v1/projects/:id/files/:fileId/download'] },
  );
  
  registerTool(
    ['agent_hq_upload_project_file', 'atlas_upload_project_file'],
    'Upload/create a project file through a typed MCP JSON/base64 input. The MCP bridge builds multipart/form-data server-side for the existing REST route.',
    {
      project_id: z.number().int().positive().describe('Project ID'),
      filename: z.string().min(1).describe('Original filename to store'),
      content_base64: z.string().min(1).describe('File content encoded as base64'),
      mime_type: z.string().optional().describe('MIME type; defaults to application/octet-stream'),
      uploaded_by: z.string().optional().describe('Audit/display actor for the upload'),
    },
    ({ project_id, filename, content_base64, mime_type, uploaded_by }) => wrap(() => api.uploadProjectFile(project_id, { filename, content_base64, mime_type, uploaded_by }))(),
    { domain: 'project_files', rest_paths: ['/api/v1/projects/:id/files'] },
  );
  
  registerTool(
    ['agent_hq_delete_project_file', 'atlas_delete_project_file'],
    'Delete a project file by project and file ID.',
    {
      project_id: z.number().int().positive().describe('Project ID'),
      file_id: z.number().int().positive().describe('Project file ID'),
    },
    ({ project_id, file_id }) => wrap(() => api.deleteProjectFile(project_id, file_id))(),
    { domain: 'project_files', rest_paths: ['/api/v1/projects/:id/files/:fileId'] },
  );
  
  registerTool(
    ['agent_hq_replace_project_file', 'atlas_replace_project_file'],
    'Replace the current content for a project file in place. The current file ID is retained and a new version-history entry is recorded.',
    {
      project_id: z.number().int().positive().describe('Project ID'),
      file_id: z.number().int().positive().describe('Existing project file ID to delete before upload'),
      filename: z.string().min(1).describe('Original filename for the replacement file'),
      content_base64: z.string().min(1).describe('Replacement file content encoded as base64'),
      mime_type: z.string().optional().describe('MIME type; defaults to application/octet-stream'),
      uploaded_by: z.string().optional().describe('Audit/display actor for the replacement upload'),
    },
    ({ project_id, file_id, filename, content_base64, mime_type, uploaded_by }) => wrap(() => api.replaceProjectFile(project_id, file_id, { filename, content_base64, mime_type, uploaded_by }))(),
    { domain: 'project_files', rest_paths: ['/api/v1/projects/:id/files/:fileId'] },
  );

  registerTool(
    ['agent_hq_list_workflow_files', 'atlas_list_workflow_files'],
    'List files uploaded to one workflow. Results include scope=workflow plus tenant, project, workflow, file, version, size/type, and timestamps.',
    {
      project_id: z.number().int().positive().describe('Project ID that owns the workflow'),
      workflow_id: z.number().int().positive().describe('Workflow ID (legacy sprint_id)'),
    },
    ({ project_id, workflow_id }) => wrap(() => api.listWorkflowFiles(project_id, workflow_id))(),
    { domain: 'workflow_files', rest_paths: ['/api/v1/projects/:projectId/workflows/:workflowId/files'] },
  );

  registerTool(
    ['agent_hq_get_workflow_file', 'atlas_get_workflow_file'],
    'Read workflow-file metadata by project, workflow, and file ID.',
    {
      project_id: z.number().int().positive().describe('Project ID that owns the workflow'),
      workflow_id: z.number().int().positive().describe('Workflow ID (legacy sprint_id)'),
      file_id: z.number().int().positive().describe('Workflow file ID'),
    },
    ({ project_id, workflow_id, file_id }) => wrap(() => api.getWorkflowFile(project_id, workflow_id, file_id))(),
    { domain: 'workflow_files', rest_paths: ['/api/v1/projects/:projectId/workflows/:workflowId/files/:fileId'] },
  );

  registerTool(
    ['agent_hq_list_workflow_file_versions', 'atlas_list_workflow_file_versions'],
    'List version history for a workflow file, preserving canonical file identity across replacements.',
    {
      project_id: z.number().int().positive().describe('Project ID that owns the workflow'),
      workflow_id: z.number().int().positive().describe('Workflow ID (legacy sprint_id)'),
      file_id: z.number().int().positive().describe('Workflow file ID'),
    },
    ({ project_id, workflow_id, file_id }) => wrap(() => api.listWorkflowFileVersions(project_id, workflow_id, file_id))(),
    { domain: 'workflow_files', rest_paths: ['/api/v1/projects/:projectId/workflows/:workflowId/files/:fileId/versions'] },
  );

  registerTool(
    ['agent_hq_download_workflow_file', 'atlas_download_workflow_file'],
    'Download a workflow file as agent-usable base64 content, with UTF-8 text included for text-like MIME types by default.',
    {
      project_id: z.number().int().positive().describe('Project ID that owns the workflow'),
      workflow_id: z.number().int().positive().describe('Workflow ID (legacy sprint_id)'),
      file_id: z.number().int().positive().describe('Workflow file ID'),
      include_text: z.boolean().optional().describe('Include UTF-8 text when the MIME type is text-like; defaults to true'),
    },
    ({ project_id, workflow_id, file_id, include_text }) => wrap(() => api.downloadWorkflowFile(project_id, workflow_id, file_id, include_text ?? true))(),
    { domain: 'workflow_files', rest_paths: ['/api/v1/projects/:projectId/workflows/:workflowId/files/:fileId/download'] },
  );

  registerTool(
    ['agent_hq_upload_workflow_file', 'atlas_upload_workflow_file'],
    'Upload/create a file scoped to a workflow through typed MCP JSON/base64 input.',
    {
      project_id: z.number().int().positive().describe('Project ID that owns the workflow'),
      workflow_id: z.number().int().positive().describe('Workflow ID (legacy sprint_id)'),
      filename: z.string().min(1).describe('Original filename to store'),
      content_base64: z.string().min(1).describe('File content encoded as base64'),
      mime_type: z.string().optional().describe('MIME type; defaults to application/octet-stream'),
      uploaded_by: z.string().optional().describe('Audit/display actor for the upload'),
    },
    ({ project_id, workflow_id, filename, content_base64, mime_type, uploaded_by }) => wrap(() => api.uploadWorkflowFile(project_id, workflow_id, { filename, content_base64, mime_type, uploaded_by }))(),
    { domain: 'workflow_files', rest_paths: ['/api/v1/projects/:projectId/workflows/:workflowId/files'] },
  );

  registerTool(
    ['agent_hq_delete_workflow_file', 'atlas_delete_workflow_file'],
    'Delete a workflow file by project, workflow, and file ID.',
    {
      project_id: z.number().int().positive().describe('Project ID that owns the workflow'),
      workflow_id: z.number().int().positive().describe('Workflow ID (legacy sprint_id)'),
      file_id: z.number().int().positive().describe('Workflow file ID'),
    },
    ({ project_id, workflow_id, file_id }) => wrap(() => api.deleteWorkflowFile(project_id, workflow_id, file_id))(),
    { domain: 'workflow_files', rest_paths: ['/api/v1/projects/:projectId/workflows/:workflowId/files/:fileId'] },
  );

  registerTool(
    ['agent_hq_replace_workflow_file', 'atlas_replace_workflow_file'],
    'Replace the current content for a workflow file in place. The workflow file ID is retained and a new version-history entry is recorded.',
    {
      project_id: z.number().int().positive().describe('Project ID that owns the workflow'),
      workflow_id: z.number().int().positive().describe('Workflow ID (legacy sprint_id)'),
      file_id: z.number().int().positive().describe('Existing workflow file ID to replace'),
      filename: z.string().min(1).describe('Original filename for the replacement file'),
      content_base64: z.string().min(1).describe('Replacement file content encoded as base64'),
      mime_type: z.string().optional().describe('MIME type; defaults to application/octet-stream'),
      uploaded_by: z.string().optional().describe('Audit/display actor for the replacement upload'),
    },
    ({ project_id, workflow_id, file_id, filename, content_base64, mime_type, uploaded_by }) => wrap(() => api.replaceWorkflowFile(project_id, workflow_id, file_id, { filename, content_base64, mime_type, uploaded_by }))(),
    { domain: 'workflow_files', rest_paths: ['/api/v1/projects/:projectId/workflows/:workflowId/files/:fileId'] },
  );
}
