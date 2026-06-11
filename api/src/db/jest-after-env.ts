afterEach(() => {
  const taskLifecycle = require('../lib/taskLifecycle') as Partial<typeof import('../lib/taskLifecycle')>;
  taskLifecycle.clearPendingEndedActiveInstanceLinkageCleanupTimers?.();
});
