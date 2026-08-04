// A PostgreSQL run needs a longer hook budget than SQLite's.
//
// jest's default is 5s, which is generous for `:memory:` and not enough for the first file in
// each worker: that one pays for the template build — 71 tables, 224 indexes, 130 foreign keys
// from db/pg-baseline plus the migrations, behind an advisory lock every other worker is waiting
// on — and then for CREATE DATABASE ... TEMPLATE. Subsequent files in the same worker only
// truncate and are fast.
//
// Raised only when AGENT_HQ_TEST_PG_URL is set. On SQLite the 5s default stays, where a hook
// that slow is a real signal rather than the cost of building a schema.
if (process.env.AGENT_HQ_TEST_PG_URL) {
  jest.setTimeout(60_000);
}

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
