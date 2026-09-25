# Async conversion: what broke, and why the compiler couldn't tell us

Written during the better-sqlite3 → async `Db` adapter conversion. Records the defect
classes found, because they recur, and because **most of them produce zero type errors**.

## The governing lesson

`tsc --noEmit` reporting zero errors says almost nothing about whether this conversion is
correct. Discarding a promise is legal TypeScript. So is negating one, or passing an async
callback to a synchronous array predicate. The most damaging defects found were all
invisible to the type checker, and several were invisible to grep as well — the source text
is indistinguishable from correct code. They are only findable by asking the type checker
what an expression's TYPE is at positions where the value gets used as something it isn't.

The conversion reached zero compile errors with 120 tests failing. Getting from there to
here was almost entirely about defects with no diagnostic attached.

## Defect classes, ordered by damage done

### 1. Discarded promise

```ts
const pushValue = async (col, val) => { if (!await hasColumn(db, col)) return; columns.push(col); ... };
pushValue('tenant_id', tenantId);        // not awaited
// ...
await db.run(`INSERT INTO logs (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`);
```

`columns` is still empty when the statement is built: `INSERT INTO logs () VALUES ()`.
**36 test failures from this one function.**

Symptoms:
- `near ")": syntax error` — a list built by unawaited pushes was empty
- `no such column: object Promise` / `near "[object Promise]"` — a promise was
  string-interpolated into SQL
- `The database connection is not open` — the promise resolved after teardown closed it

The migration-time `fix-floating-promises.mjs` detector asked the checker whether a discarded
expression statement had a `Promise` type. It found 105. That one-off conversion tool was retired
with the PostgreSQL-only release after the affected code was reviewed.

**Do not fix these in bulk.** Running the fixer across all 105 took failing suites from 41
to 87 and stopped 539 tests from running at all. Many source-level discarded promises are
DELIBERATE fire-and-forget in event handlers and shutdown paths, where inserting an `await`
changes ordering or deadlocks. The tool now requires `--tests-only` or `--source-only`.
Applied to tests alone it was clean.

### 2. Discarded promise that was a guard

```ts
enforceMcpTenantScope(id, 'explicit');
requireTenant(id);      // became async; not awaited
return id;
```

`requireTenant` verifies the tenant EXISTS. Unawaited, that check no longer ran before the
id was returned. The comment directly above these lines explains that their ORDER is
deliberate — it stops an unauthorized MCP key distinguishing 404 from 403 and probing which
tenant IDs exist. The check the comment is about had silently stopped executing.

Generalise this: **a discarded promise in a guard is an unenforced guard.** Every
validation, authorization or precondition function that became async needs auditing — not
only the ones whose absence produces a visible error.

### 3. Promise used as a boolean

```ts
if (transcriptOutput && !this.hasHermesJsonTranscriptRows(db, instanceId)) { ... }
```

A Promise is always truthy, so `!promise` is always `false` and the block is dead code.
Here it meant that when a Hermes run aborted or exited non-zero, the fallback persisting its
stdout as the assistant message never ran — an empty transcript for exactly the runs an
operator most needs to read. Three sites in one file.

### 4. Async callback passed to a SYNCHRONOUS array predicate

The subtlest of the set, and worth its own entry because it looks nothing like a bug:

```ts
['repo_path', 'repo_url', 'repo_access_mode']
  .every(async (column) => await tableHasColumn(db, 'sprints', column));
```

`every`/`some`/`filter`/`find` evaluate the callback's return value immediately. An async
callback returns a Promise, always truthy, so:

- `.every(async …)` returns **true** unconditionally
- `.filter(async …)` keeps **every** element
- `.some(async …)` is **true** for any non-empty array

Nine sites, every one a real behavioural bug:

| Site | Effect |
|---|---|
| `dispatcher.ts` ×2 | Schema-capability flags always "present" → the routing-rule query matched nothing → **the dispatcher dispatched 0 tasks.** 32 test failures. |
| `watchdog.ts` ×3 | All three capability flags always true |
| `agents.ts` ×2 | `hasProjectRepoColumns` always true |
| `runtimeTenantScope.ts` | A guard that never fired |
| `routes/tasks.ts` | Every task reported as integrity-flagged; the same map was also unawaited and `results` is serialised into the response, so the endpoint returned an array of **empty objects** |
| `sprint-definitions` | The system `pm` type always visible |

`map`/`forEach`/`flatMap` are fine — an async callback there is normal, usually with
`Promise.all`. The migration-time `find-promise-conditions.mjs` detector was retired after the
conversion audit completed.

### 5. A pragma window that stopped being atomic

The foreign-key guard was converted to hold `PRAGMA foreign_keys = OFF` across `await`
points on the process-wide shared connection. Because every adapter method is async, other
request handlers' continuations then ran INSIDE that window, and their `DELETE`s executed
with `ON DELETE CASCADE` disabled — silently orphaning rows, with the pragma restored
afterwards so nothing was logged.

This is the same defect that had already shipped to production once. The synchronous guard
could not do it, because nothing could interleave.

The subtlety: making the callback body contain no `await` is NOT sufficient. Awaiting an
already-resolved promise still yields to the microtask queue. **The wrapper itself must be
synchronous.**

### 6. Callback TYPES left synchronous

```ts
getTaskRecord: (taskId: number) => TaskWorktreeRecord;   // the callback is now async
hasLiveInstance: (path: string, id: number | null) => boolean;
```

The declared types still promised a boolean, so passing an async callback typechecked and
`hasLiveInstance` returned a truthy *Promise* for every directory — nothing would ever have
been pruned. Signatures must follow their implementations.

### 7. Stale mocks

A suite mocking `prepare(sql).get()` against code that now calls `db.get(sql, …)` is
**stale, not mistyped**. Retyping it produces a suite that compiles, passes, and asserts
against a shape nothing uses.

Worse, interceptors go quiet. One test wrapped `db.prepare` to observe a write and record
ordering; the adapter has no `prepare`, so the wrapper never fired and the assertion failed
for a reason unrelated to the behaviour under test.

`src/runtimes/HermesRuntime.test.ts` is the worked example (14 failures → 0): keep the
statements-keyed map of canned results as the source of truth, change only the calling
convention, dedupe by exact SQL so assertions see every invocation on one mock.

## The open architectural problem

The largest remaining failure cluster is not a missing `await` in the failing test. It is a
lifecycle race the conversion created:

```ts
async function resetDb() {
  closeDb();                                  // closes the connection FIRST
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.env.AGENT_HQ_DB_PATH = newPath;
  const db = getDb();
```

Request handling used to be synchronous: when a test returned, its database work was
finished. Now handlers are async, so work from the PREVIOUS test can still be in flight when
the next one closes the connection.

Adapter-level in-flight tracking does **not** fix this. Under SQLite each individual
operation still completes synchronously; the gap is BETWEEN operations —
`ensureTenantSchema` performs dozens of sequential awaits, and teardown runs in one of those
gaps. So the fix is that each test awaits its own work to completion, which means reading
each affected suite. Not a codemod — which is precisely what the failed bulk fix showed.

**This is also a cutover risk, not only a test problem.** The same window exists in
production between a shutdown signal and in-flight request work.

## Practical guidance

1. Zero type errors is a starting line, not a finish line.
2. Drive fixes from compiler DIAGNOSTICS wherever a diagnostic exists — a missing await is
   invisible in source text and identifiable only from the callee's type.
3. For the classes with no diagnostic, the only tools are a type-aware detector and reading
   for intent. Budget for the reading.
4. Never bulk-apply a semantic fix across a population you have not partitioned. Deliberate
   and accidental fire-and-forget are identical in the AST.
5. Fix the SOURCE when the source is wrong. Several of these were real product bugs — an
   endpoint returning empty objects, a dispatcher dispatching nothing, an authorization check
   not running — reached through a failing test. Adjusting the test would have buried them.
6. A test that passes because it stopped checking anything is worse than a failing test.

## Temporary tooling produced

These one-off conversion scripts were removed with the PostgreSQL-only release. Their names and
purposes remain here as historical context for the defects and review process.

| Script | Purpose |
|---|---|
| `codemod-to-adapter.mjs` | The conversion itself: 3,735 call sites, async propagation to a fixpoint |
| `codemod-tests-to-adapter.mjs` | Gives test files both a raw handle and an adapter |
| `fix-async-residue.mjs` | Diagnostic-driven: missing awaits, unlifted return types, handle types |
| `fix-floating-promises.mjs` | Type-aware discarded-promise finder (`--tests-only` / `--source-only`) |
| `find-promise-conditions.mjs` | Promises used as booleans, including async callbacks in sync predicates |
| `fix-from-tsc.mjs` | Location-precise edits driven by tsc output |
