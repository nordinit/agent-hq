/** Explicit authorities: no key role or broad business-admin grant implies these. */
export const ACCESS_CAPABILITIES = [
    ['projects.read_all', 'Read all project boards', 'Read safe project, workflow, task and agent status across this tenant; no writes, callbacks, files, secrets or host probes.'],
    ['tools.read', 'Read capability registry', 'Read sanitized tools, MCP servers, skills, teams and assignments; executable bodies and launch secrets are excluded.'],
    ['tools.register', 'Register executable drafts', 'Create and edit draft tool and MCP definitions. Existing published revisions remain immutable.'],
    ['tools.publish', 'Publish executable revisions', 'Approve exact executable revisions and their input/launch policy. Publication does not invoke code.'],
    ['tools.assign', 'Assign published capabilities', 'Bind approved revisions to agents or teams. Does not grant execution authority to the recipient.'],
    ['tools.execute', 'Invoke approved tools', 'Invoke or test a published, assigned tool revision. Tests execute real code.'],
    ['host.configure', 'Configure host execution', 'Author protected runtime, setup, workspace and gateway configuration. Publication is required before runtime launch.'],
    ['host.execute', 'Launch approved host processes', 'Launch processes under an approved execution profile. Does not imply root or OS sandboxing.'],
    ['host.files.read', 'Read agent workspace files', 'Read workspace file contents, separately from project board access.'],
    ['permissions.manage', 'Manage permission grants', 'Manage other identities within the caller’s existing authority. Cannot self-elevate or delegate missing grants.'],
    ['runs.dispatch', 'Delegate work to approved runtimes', 'Trigger dispatch, send runtime chat turns or run scheduled work using published runtime profiles.'],
].map(([key, label, description]) => ({ key, label, description, group: 'Access boundaries', endpoints: [] as string[], defaultEnabled: { scoped_runtime: false, trusted_admin: false } })) as Array<{
    key: 'projects.read_all' | 'tools.read' | 'tools.register' | 'tools.publish' | 'tools.assign' | 'tools.execute' | 'host.configure' | 'host.execute' | 'host.files.read' | 'permissions.manage' | 'runs.dispatch';
    label: string;
    description: string;
    group: string;
    endpoints: string[];
    defaultEnabled: {
        scoped_runtime: false;
        trusted_admin: false;
    };
}>;
export const ACCESS_PRESETS = {
    observer: ['projects.read_all', 'discovery.read_catalog'],
    registry_author: ['projects.read_all', 'tools.read', 'tools.register', 'discovery.read_catalog'],
    publisher: ['tools.read', 'tools.publish', 'tools.assign', 'discovery.read_catalog'],
    executor: ['tools.read', 'tools.execute', 'host.execute', 'discovery.read_catalog'],
    project_operator: ['projects.read_all', 'tasks.read_project_context', 'tasks.manage_project_tasks', 'tasks.write_project_notes', 'projects.read_project_board', 'discovery.read_catalog'],
    host_administrator: ['tools.read', 'tools.register', 'tools.publish', 'tools.assign', 'tools.execute', 'host.configure', 'host.execute', 'host.files.read', 'runs.dispatch', 'discovery.read_catalog'],
} as const;
export const EXPLICIT_AUTHORITIES = new Set<string>(ACCESS_CAPABILITIES.map(x => x.key));
