import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProfileChange } from './api';
import { describeValue, fieldGuide } from './approvalFields.ts';

const change = (path: string, label = path): ProfileChange => ({ path, label, change: 'added', before: null, after: null });
const ctx = { agentId: 7, agentName: 'Builder', workflowId: 114, workflowName: 'Lead Generation' };

test('environment setup says what each mode does, in words', () => {
  assert.equal(describeValue('environment_setup', '{\n  "mode": "off"\n}'), 'Off: nothing runs before the agent starts. The agent starts in its workspace as it is.');
  assert.match(describeValue('environment_setup', JSON.stringify({ mode: 'auto', roots: ['.'], timeoutSeconds: 600 }))!,
    /^Automatic: Agent HQ finds the project’s lockfile in the repository .* It stops after 600 seconds\.$/);
  assert.equal(
    describeValue('environment_setup', JSON.stringify({ mode: 'custom', steps: [{ command: ['npm', 'ci'], cwd: '.' }, { command: ['make', 'build'], cwd: 'web' }], timeoutSeconds: 300 })),
    'Custom: runs these commands in order, every time, before the agent starts:\n1. npm ci\n2. make build (in web)\nIt stops after 300 seconds.',
  );
  assert.equal(describeValue('repo_access_mode', 'clone'), 'Clone: each task gets a fresh clone of the repository URL.');
  assert.equal(describeValue('repo_access_mode', null), 'No repository: the agent works in its own workspace folder.');
  assert.equal(describeValue('runtime_type', 'claude-code'), 'Claude Code');
  // Plain text such as instructions already reads plainly.
  assert.equal(describeValue('job_instructions', 'Build it.'), null);
});

test('every setting says what it is, why it needs approval and where to change it', () => {
  const setup = fieldGuide(change('environment_setup'), ctx);
  assert.match(setup.what, /before the agent starts/);
  assert.match(setup.what, /each agent needs its own approval/);
  assert.match(setup.why, /as your user account/);
  assert.deepEqual(setup.where, { label: 'Workflows → Lead Generation → Edit', href: '/workflows/114' });

  assert.deepEqual(fieldGuide(change('job_instructions'), ctx).where, { label: 'Builder’s agent page', href: '/agents/7' });
  assert.deepEqual(fieldGuide(change('skills.create-task'), ctx).where, { label: 'Skills → create-task', href: '/skills/create-task' });
  assert.deepEqual(fieldGuide(change('skill_files.create-task/run.sh'), ctx).where, { label: 'Skills → create-task', href: '/skills/create-task' });
  assert.deepEqual(fieldGuide(change('teams.12'), ctx).where, { label: 'The team’s page', href: '/teams/12' });
  assert.deepEqual(fieldGuide(change('credentials.github_identities.3'), ctx).where, { label: 'Settings → GitHub', href: '/settings/github' });
  assert.deepEqual(fieldGuide(change('credentials.provider_connections.3'), ctx).where, { label: 'Settings → Providers', href: '/settings/providers' });
  for (const path of ['name', 'role', 'model', 'preferred_provider', 'runtime_type', 'runtime_config', 'workspace_path', 'hooks_url', 'hooks_auth_header',
    'os_user', 'github_identity_id', 'provider_connection_id', 'job_instructions', 'skill_names', 'repo_path', 'repo_url', 'repo_access_mode', 'environment_setup']) {
    const guide = fieldGuide(change(path), ctx);
    assert.ok(guide.what.length > 20 && guide.why.length > 10 && guide.where, `${path} is explained`);
  }
});
