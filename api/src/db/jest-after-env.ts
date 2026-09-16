// The first database-using file in each worker may wait for the versioned template to be built.
jest.setTimeout(60_000);

afterEach(() => {
  const taskLifecycle = require('../lib/taskLifecycle') as Partial<typeof import('../lib/taskLifecycle')>;
  taskLifecycle.clearPendingEndedActiveInstanceLinkageCleanupTimers?.();
  const localProcesses = require('../runtimes/localProcessSupervisor') as typeof import('../runtimes/localProcessSupervisor');
  localProcesses.localProcessSupervisor.clearForTests();
});

// Fixtures own their PostgreSQL pools. Tests may close pools between cases, but
// the same worker database is reused and reset by truncation, not cloned again.
// A database without connections can therefore still belong to a live worker.
// Global setup only reaps databases stamped with a proven exited local owner;
// shared templates and unknown/remote owners require explicit cleanup.
