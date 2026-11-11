import { triggerDispatch } from './dispatchTrigger';
import { runDispatcher } from './dispatcher';

jest.mock('../db/client', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('./dispatcher', () => ({ runDispatcher: jest.fn(async () => ({ dispatched: 0, skipped: 0, errors: [] })) }));
jest.mock('../scheduler/reconciler', () => ({ reconcileAssignedAgents: jest.fn(async () => undefined) }));

describe('automatic mutation-triggered dispatch scope', () => {
  const original = process.env.AGENT_HQ_AUTOMATION_PROJECT_IDS;
  afterEach(() => {
    jest.clearAllMocks();
    if (original === undefined) delete process.env.AGENT_HQ_AUTOMATION_PROJECT_IDS;
    else process.env.AGENT_HQ_AUTOMATION_PROJECT_IDS = original;
  });
  it('does not launch an unrelated project after a mutation', async () => {
    process.env.AGENT_HQ_AUTOMATION_PROJECT_IDS = '3,99';
    triggerDispatch(86);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runDispatcher).not.toHaveBeenCalled();
  });
  it('continues dispatching an explicitly resumed project', async () => {
    process.env.AGENT_HQ_AUTOMATION_PROJECT_IDS = '3,99';
    triggerDispatch(3);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runDispatcher).toHaveBeenCalledWith(expect.anything(), 3);
  });
});
