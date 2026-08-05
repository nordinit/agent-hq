import { fingerprintRuntimeBoundaryV1, type RuntimeBoundaryV1 } from '../runtimeBoundary';
import { assertCodexResumeAllowed } from './resume';

function boundary(): RuntimeBoundaryV1 {
  const value: RuntimeBoundaryV1 = {
    version: 1,
    identity: {
      tenantId: 2, projectId: 3, workflowId: 4, taskId: 5,
      instanceId: 7, durableRunId: 'run-7', agentId: 42, agentSlug: 'builder',
    },
    runtime: {
      type: 'codex', driverVersion: 'codex-driver/1',
      executableFingerprint: 'sha256:test-codex-executable', configRevision: 'config',
      model: 'gpt-5.5', reasoning: 'high', fastMode: false,
      timeoutSeconds: 60, tokenBudget: null, turnLimit: null,
    },
    workspace: {
      workspaceRoot: '/work', activeRepoRoot: '/work/task', repoAccessMode: 'worktree',
      repoSource: 'worktree:/repo', branch: 'agent/task', commit: null,
      fingerprint: 'workspace-fingerprint',
    },
    prompt: { bundleFingerprint: 'prompt-fingerprint' },
    executionTarget: {
      id: 'local:codex', kind: 'local-process', trustLevel: 'workspace',
      capabilities: ['inspect', 'resume', 'signals', 'workspace-write'],
    },
    tools: { builtIn: [], mcpServers: [], requiredLifecycleTools: [], skills: [] },
    auth: { provider: 'openai-codex', providerConnectionId: 9, credentialRefs: [] },
    evidence: { required: false, requirements: [] },
    callback: { identity: 'run:7' },
    priorCheckpoint: null,
    observability: { traceId: 'trace', correlationId: 'correlation', requestedBy: 'test' },
  };
  const fingerprint = fingerprintRuntimeBoundaryV1(value);
  value.priorCheckpoint = {
    executionId: 81,
    checkpointId: 82,
    sequence: 3,
    boundaryFingerprint: fingerprint,
  };
  return value;
}

describe('assertCodexResumeAllowed', () => {
  it('accepts only the tenant/instance/session checkpoint matching the full boundary', async () => {
    const db = { get: jest.fn(async () => ({ id: 82 })) } as never;
    await expect(assertCodexResumeAllowed({
      db,
      boundary: boundary(),
      instanceId: 7,
      sessionId: 'thread-123',
    })).resolves.toBeUndefined();
    expect((db as { get: jest.Mock }).get).toHaveBeenCalledWith(
      expect.stringContaining('re.tenant_id = ?'),
      82, 81, 3, expect.stringMatching(/^sha256:/), 'thread-123', 7, 2,
    );
  });

  it('rejects a direct resume id without a validated checkpoint', async () => {
    await expect(assertCodexResumeAllowed({
      db: null,
      boundary: null,
      instanceId: 7,
      sessionId: 'untrusted-thread',
    })).rejects.toThrow('runtime_config.resumeSessionId cannot be used directly');
  });

  it('rejects a changed resume-sensitive boundary before querying the database', async () => {
    const changed = boundary();
    changed.workspace.activeRepoRoot = '/other/worktree';
    const db = { get: jest.fn() } as never;
    await expect(assertCodexResumeAllowed({
      db,
      boundary: changed,
      instanceId: 7,
      sessionId: 'thread-123',
    })).rejects.toThrow('boundary fingerprint does not match');
    expect((db as { get: jest.Mock }).get).not.toHaveBeenCalled();
  });

  it('rejects executable fingerprint drift before querying the database', async () => {
    const changed = boundary();
    changed.runtime.executableFingerprint = 'sha256:replacement-codex-executable';
    const db = { get: jest.fn() } as never;
    await expect(assertCodexResumeAllowed({
      db,
      boundary: changed,
      instanceId: 7,
      sessionId: 'thread-123',
    })).rejects.toThrow('boundary fingerprint does not match');
    expect((db as { get: jest.Mock }).get).not.toHaveBeenCalled();
  });
});
