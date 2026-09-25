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

  it('reports a failed dispatch by status without echoing the endpoint response or URL', async () => {
    global.fetch = jest.fn(async (..._args: Parameters<typeof fetch>) => ({
      ok: false,
      status: 500,
      text: async () => 'root:x:0:0:root:/root:/bin/bash\nAWS_SECRET_ACCESS_KEY=abc123',
    } as unknown as Response)) as jest.MockedFunction<typeof fetch>;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const runtime = new WebhookRuntime({ dispatchUrl: 'http://10.0.0.5/dispatch?token=hook-secret' });
    const failure = await runtime.dispatch(buildParams()).then(() => null, (err: Error) => err);

    expect(failure?.message).toBe('WebhookRuntime: dispatch endpoint returned HTTP 500');
    expect(failure?.message).not.toMatch(/root:x|AWS_SECRET|hook-secret/);
  });

  it('does not put the dispatch URL in network errors', async () => {
    global.fetch = jest.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      throw new Error('fetch failed');
    }) as jest.MockedFunction<typeof fetch>;

    const runtime = new WebhookRuntime({ dispatchUrl: 'http://10.0.0.5/dispatch?token=hook-secret' });
    await expect(runtime.dispatch(buildParams())).rejects.toThrow('WebhookRuntime: dispatch request failed — fetch failed');
  });

  it('rejects removed lifecycleProxy config clearly', () => {
    expect(() => new WebhookRuntime({
      dispatchUrl: 'https://remote.example/dispatch',
      lifecycleProxy: true,
    })).toThrow('runtime_config.lifecycleProxy is no longer supported');
  });
});
