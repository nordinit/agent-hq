import { WebhookRuntime } from './WebhookRuntime';
import type { DispatchParams } from './types';

function buildParams(overrides: Partial<DispatchParams> = {}): DispatchParams {
  return {
    message: 'Run the task',
    agentSlug: 'remote-agent',
    sessionKey: 'run:123',
    timeoutSeconds: 30,
    name: 'Task 123',
    instanceId: 123,
    taskId: 456,
    ...overrides,
  };
}

describe('WebhookRuntime', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('dispatches without lifecycle callback URLs', async () => {
    const fetchMock = jest.fn(async (..._args: Parameters<typeof fetch>) => ({
      ok: true,
      json: async () => ({ runId: 'webhook-run-1' }),
    } as Response)) as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock;

    const runtime = new WebhookRuntime({ dispatchUrl: 'https://remote.example/dispatch' });
    const result = await runtime.dispatch(buildParams());

    expect(result.runId).toBe('webhook-run-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      message: 'Run the task',
      agentId: 'remote-agent',
      sessionKey: 'run:123',
      timeoutSeconds: 30,
      name: 'Task 123',
      instanceId: 123,
      taskId: 456,
    });
    expect(body).not.toHaveProperty('callbackUrls');
    expect(JSON.stringify(body)).not.toContain('/api/v1/instances');
  });

  it('rejects removed lifecycleProxy config clearly', () => {
    expect(() => new WebhookRuntime({
      dispatchUrl: 'https://remote.example/dispatch',
      lifecycleProxy: true,
    })).toThrow('runtime_config.lifecycleProxy is no longer supported');
  });
});
