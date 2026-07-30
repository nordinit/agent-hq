afterEach(() => {
  const taskLifecycle = require('../lib/taskLifecycle') as Partial<typeof import('../lib/taskLifecycle')>;
  taskLifecycle.clearPendingEndedActiveInstanceLinkageCleanupTimers?.();
});

// The PostgreSQL pool is deliberately NOT closed here.
//
// Closing it per FILE looked tidy and was wrong for the same reason closing it per TEST was:
// closeTestDb() clears testFixture's cached handle, so the next file's setup re-enters the clone
// path and runs DROP DATABASE + CREATE DATABASE ... TEMPLATE again. Cloning a 71-table template is
// slow enough that whole files then failed on jest's 5s timeout — including under --runInBand,
// which is what ruled out worker contention as the cause and pointed back here.
//
// The fixture's model is one database per WORKER, held for the worker's lifetime and reset by
// truncation in setupTestDb(). One clone per worker instead of one per file is the difference
// between a suite that finishes and one that times out. The database is dropped by
// dropWorkerDatabase(), and stale ones are reaped by global setup on the next run.
