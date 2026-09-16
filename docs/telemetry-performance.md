# Telemetry performance and recovery validation

## Measurement status

The final benchmark completed successfully on September 10, 2026, against the implementation through migration 30. The environment timestamp is **04:56:27.094 UTC**. Both the 1,000-task and 10,000-task populations were complete, and their recorded aggregates matched the synthetic fixture. All numbers below come from this run's [telemetry-performance-results.json](telemetry-performance-results.json).

The host is an Apple M4 with 10 CPU threads and 16 GiB of memory, running arm64 Darwin 24.6.0, Node 24.18.0, and local PostgreSQL 17.9. PostgreSQL used 128 MiB shared buffers, 4 MiB work memory and a 100-connection limit, with `fsync` and synchronous commit enabled. Queries ran sequentially against a warm local database; these are service timings, without HTTP or browser-rendering overhead.

The benchmark itself is implemented in `api/src/tooling/benchmarkTelemetry.ts`. It uses the existing disposable PostgreSQL fixture, creates a process-specific test database, and drops that database when it exits. It never opens the application's configured database. Run from `api/`:

```sh
AGENT_HQ_TEST_PG_URL=postgresql://localhost/postgres node --import tsx src/tooling/benchmarkTelemetry.ts
```

## Reproducible workload

The default run measures 1,000 tasks with 5,000 task observations, then 10,000 tasks with 50,000 task observations. Small configuration observations are counted separately in the output. Each population uses one tenant, project, workflow type, workflow, numeric custom field, and ten assigned agents. Five real canonical task writes generate each task's producer snapshots. Synthetic event timestamps provide known start/end boundaries and complete observation coverage; no legacy history is asserted to be complete.

The actual `queryTelemetry` service is measured, including scope authorization, catalog resolution, compilation, snapshot reads, evaluation, contributor construction, and retained-result writes. Each metric has two warmups and ten timed samples; contributor paging has ten samples against an already retained result. The JSON artifact records p50/p95 and metric minimum/maximum timings. With ten samples, nearest-rank p95 is the slowest sample; this is a bounded smoke benchmark, not a stable tail-latency estimate.

The workflow statuses are **unregistered status keys**. This exercises the explicit unregistered-identity path, not a catalog containing hundreds of configured status/outcome descriptors. The fixture also does not contain a large library of saved metrics, profiles or bindings. Those catalog and definition-resolution costs need a separate workload.

| Query | Expected correctness check |
| --- | --- |
| Current custom numeric sum | 50,500 at 1,000 tasks; 505,000 at 10,000 |
| Configurable first pass grouped by assigned agent at entry | 800/1,000 and 8,000/10,000; ten groups |
| Start-to-resolution duration distribution | One completed duration per task; explicit 300/450/600-second bucket boundaries |
| Retained contributor page | Last page of 200 contributors; total matches the population |

The artifact also records OS, CPU, memory, Node and PostgreSQL versions, relevant PostgreSQL settings, full SQL `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for each query's three slowest reads, relation sizes, process RSS, canonical capture duration, oldest pending age, and worker catch-up throughput. Results are written after each population, so a failure at 10,000 preserves the 1,000-task measurements and records the failure. Counts above 10,000, dense dependency graphs, multiple simultaneous operators, background-limit populations, mixed tenants, and long retention windows are not covered by this workload.

## Measured query latency

Each cell is **p50 / p95 milliseconds**. These timings include retained proof writes; the contributor timing reads an already retained result.

| Actual service operation | 1,000 tasks / 5,014 observations | 10,000 tasks / 50,014 observations |
| --- | ---: | ---: |
| Current numeric sum | 156.47 / 162.28 | 1,564.82 / 1,820.84 |
| First pass, ten agent groups | 320.85 / 338.09 | 3,039.54 / 3,485.59 |
| Duration distribution | 266.13 / 286.24 | 2,876.57 / 3,207.66 |
| Last 200 contributors | 3.13 / 4.98 | 30.24 / 41.75 |

The 10,000-task sum was 505,000 and first pass was 8,000/10,000 (80%). Duration bucket counts were 1,675, 4,218, 4,107, and zero, totaling 10,000. Contributor totals matched both populations. Each population retained 36 query records: twelve evaluations for each of three metrics, including warmups.

The tenfold population increase raised median metric latency roughly 9.5–10.8 times. At 10,000 tasks, numeric-sum samples ranged from 1,363.77 to 1,820.84 ms, first pass from 2,801.44 to 3,485.59 ms, and duration distribution from 2,656.33 to 3,207.66 ms. These results characterize the existing interactive limit for this workload; they do not establish concurrency capacity or a production p95 service objective. HTTP delivery and browser rendering add further latency.

## Capture, projection, and memory

| Measurement | 1,000 tasks | 10,000 tasks |
| --- | ---: | ---: |
| Five canonical task mutations per task, including capture | 2,044.12 ms | 24,922.50 ms |
| Pending facts before projection | 5,014 | 50,014 |
| Age of oldest pending fact before projection | 2.18 s | 26.54 s |
| Tight-loop projection catch-up, batches of 1,000 | 199.12 ms | 2,796.05 ms |
| Tight-loop projection throughput | 25,180 facts/s | 17,887 facts/s |
| Pending facts after projection | 0 | 0 |
| Node resident memory after workload | 379.70 MiB | 1,050.33 MiB |

**The projection measurement is an explicit catch-up loop, not the scheduled worker's end-to-end latency.** The benchmark intentionally postpones projection until seeding finishes, then calls the real projection function repeatedly without waiting between batches. The startup worker uses batches of 1,000, repeating successful batches within a 500 ms work budget on each one-second tick. It stops when the queue is empty, no rows are eligible, or the elapsed budget is reached; the existing active guard prevents overlapping ticks. The budget is checked between atomic batches, so one in-flight batch can exceed the time boundary. Pending counts and oldest pending timestamps expose remaining lag. That schedule has correctness tests but is not exercised by this tight-loop measurement; sustained production ingestion was not measured.

The RSS number is an end-of-workload process measurement, not a peak or a per-request allocation. The 10,000-task measurement was **1,101,348,864 bytes**, about **1.03 GiB** resident memory. The default interactive population is bounded at 10,000 tasks. A smaller deployment or concurrent queries needs separate memory validation before raising workload limits. This run did not measure multiple concurrent background jobs or operators.

## Recorded storage

Physical relation size in MiB includes heap, indexes, and TOAST storage.

| Relation | 1,000 tasks | 10,000 tasks |
| --- | ---: | ---: |
| Canonical tasks | 1.72 | 15.13 |
| Telemetry observations | 7.39 | 72.35 |
| Durable outbox | 14.95 | 148.05 |
| Retained query results, 36 exact rows | 2.64 | 20.41 |

These are immediate post-workload sizes, not a vacuumed steady-state storage model. The synthetic history update and projection acknowledgements create additional outbox row versions; no explicit vacuum/compaction was performed. The raw `estimated_rows` fields are PostgreSQL statistics and can lag the separately measured exact row counts. Do not extrapolate these figures into an unmeasured retention-period capacity estimate.

## SQL plans and remaining bottlenecks

The raw artifact includes nine full `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans per population, selected from each metric's three slowest reads. At 10,000 tasks:

- Current task snapshot loading took **1,131.43 ms** in PostgreSQL. The underlying task scan/join/sort finished in **8.60 ms**; most time was above that node, where `telemetry_task_snapshot` builds configured snapshots per row. The current and duration snapshot sorts each spilled 2,744 KiB to disk. First-pass and duration snapshot reads took **1,272.95 ms** and **1,312.37 ms**. The first-pass candidate plan also scanned 50,011 scoped observations in 66.06 ms. Resolving common workflow/schema metadata once and constructing only fields needed by the definition are useful optimization candidates, while preserving identity and access rules.
- Historical observation loading selected **50,000 records** using a parallel sequential scan, external merge sorts, and `Gather Merge`. PostgreSQL execution took **83.38 ms** for first pass and **65.83 ms** for durations. The plans wrote **6,750** and **6,748 temporary blocks**, respectively, about **52.7 MiB** each with the measured 4 MiB `work_mem`; individual sort participants reported approximately **16.6–19.3 MiB** of disk space. At 1,000 tasks the planner used `telemetry_observations_retention` and incremental sort without disk spill.
- The corresponding application-level observation reads took **603.52 ms** and **573.37 ms** during their traced samples. Those separate measurements include transfer and decoding and were not simultaneous with the later EXPLAIN runs. Their difference is evidence that reducing materialized JSON payloads deserves profiling; it is not a precise decomposition of request CPU time.
- The fixture contains no dependencies. Its empty dependency lookup is inexpensive, so these results do not characterize dense dependency graphs or global terminal-policy refresh fan-out. Contributor paging still reads retained JSON evidence before slicing it; the measured 200-row page reached **41.75 ms p95** at 10,000 contributors.

No production PostgreSQL settings were changed. Increasing global work memory based on this one run is not justified; the snapshot and materialization costs are larger priorities, and concurrent memory use remains unmeasured.

## Changes made before measurement

Outbox projection previously scanned source history to establish the capture boundary for each individual record, including when the registry already existed. It now checks/registers each source once per batch. The common projection path inserts and acknowledges a bounded batch transactionally; a failed batch rolls back to a savepoint and retries individual rows, preserving poison-record isolation. No before/after speedup is claimed without measurements.

Task dependency, run entity, and contributor lookups use indexes in memory instead of repeated scans of the same arrays. Workload limits, query evidence-size limits, SQL timeouts, and background leases remain the protective boundaries; this benchmark does not justify raising them.

## Recovery and retention evidence

Disposable PostgreSQL integration tests verify transaction rollback, a canonical mutation failing when durable capture fails, replay idempotency, two transactions committing out of outbox-ID order, poison-record retries without blocking other rows, and concurrent prerequisite resolution. Capture and retention tests cover these paths, and the catalog/correction slice also passes. Additional worker tests exercise multi-batch catch-up, stopping when pending records are not yet retry-eligible, and leaving the remainder durable when the elapsed budget is exhausted.

Retention sweeps rotate tenants and limit the number of expired roots selected from each fact store. A monotonic retained-history boundary prevents a longer retention setting from pretending discarded evidence was recovered. Both sweeps and late projection retract superseded ancestors when an expired correction is removed. Frozen artifacts have their own explicit expiry; canonical entity deletion and source ownership changes revoke retained proofs immediately. Taskless run/runtime, agent, project, workflow, and task deletion paths are covered by capture tests.

This demonstrates recovery behavior under deterministic fault injection. It does not measure process-kill recovery time, replica failover, sustained ingestion under load, or disk exhaustion.
