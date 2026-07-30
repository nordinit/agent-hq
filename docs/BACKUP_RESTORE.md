<!--
RECOVERED DOCUMENT — PROVENANCE

Source: git blob 2b12d8c7e318e8e512943daa7c3a199a5aeb30d4
Commit: 494509b5a131347e41964768ae0491f76570c8f2^ — i.e. the last revision of this file before
        494509b ("Prepare repository for public release under nord-initiatives", Cinder, 2026-06-11)
        deleted it as part of stripping ops runbooks from the public repo.

This content PREDATES the 2026-06-11 public re-root. `main` was re-rooted at b2c3705 ("Initial public
release"), so 494509b is NOT an ancestor of HEAD and this file is absent from the working tree, from
HEAD, and from a fresh clone. It survived only as an unreachable object in this worktree's object
store and would be destroyed by a routine `git gc`.

CONTENTS DESCRIBE THE PRE-MIGRATION STATE: a single-file SQLite production database backed up with
`sqlite3 .backup`. None of it applies to a PostgreSQL deployment — under Postgres the snapshot
mechanism, retention tooling, restore procedure and integrity checks all change. This runbook is
retained as the pre-cutover baseline and as the source of the rollback path that remains valid right
up to the cutover itself. It must be superseded, not merely edited, once Postgres is live.

Paths in this document are the operator's own machine layout (`~/agent-hq`, `~/.agent-hq`) and the
launchd label still carries the pre-rename `com.atlas-hq.*` prefix.
-->

# Agent HQ — Backup & Restore Runbook

## Overview

The Agent HQ production database (`~/.agent-hq/agent-hq.db`) should be backed up automatically on a schedule. Backups are intended to be stored locally and optionally off-machine.

| Location | Path | Retention |
|---|---|---|
| **Local** | `~/agent-hq/backups/` | 7 days (168 hours) by default |
| **Remote (Git host)** | `<your-private-backup-repo>` | Indefinite |

Backups use SQLite's `.backup` command for a consistent point-in-time snapshot safe to take on a live database.

---

## Backup Schedule

- **Frequency:** Once every 24 hours at 02:00 local time
- **Scheduler source of truth:** launchd job `com.atlas-hq.backup`
- **Scheduler plist:** `~/Library/LaunchAgents/com.atlas-hq.backup.plist`
- **Script:** `~/agent-hq/scripts/backup-db.sh`
- **Source database:** `~/.agent-hq/agent-hq.db` by default, configurable with `AGENT_HQ_DB_PATH`
- **Scheduler log:** `~/agent-hq/logs/backup-launchd.log`
- **Script log:** `~/agent-hq/logs/backup.log`
- **Remote repo:** `~/agent-hq-backups/` when present; currently missing on this host, so off-machine pushes are skipped and logged as a warning
- **Local backup repo dir:** `~/agent-hq-backups/`
- **Local retention:** 168 hours (7 days) by default, configurable with `AGENT_HQ_BACKUP_RETAIN_HOURS`

The old hourly launchd job (`com.atlas-hq.backup-hourly`) and stale cron entries pointing at `/Users/nordini/atlas-hq` should not be active. The daily launchd job must point at `/Users/nordini/agent-hq/scripts/backup-db.sh`. The script defaults to the active production DB path (`/Users/nordini/.agent-hq/agent-hq.db`), so the launchd job does not need to export `AGENT_HQ_DB_PATH` unless production changes to another DB file.

---

## Verify Backup Health

```bash
# View recent backups
ls -lht ~/agent-hq/backups/ | head -10

# View scheduler and script logs
tail -40 ~/agent-hq/logs/backup-launchd.log
tail -40 ~/agent-hq/logs/backup.log

# Verify active scheduler configuration
launchctl list | grep 'com.atlas-hq.backup'
plutil -p ~/Library/LaunchAgents/com.atlas-hq.backup.plist
crontab -l | grep -E 'agent-hq/scripts/backup-db|atlas-hq/scripts/backup-db' || true

# Run backup manually with restore verification. By default this backs up
# ~/.agent-hq/agent-hq.db and keeps local backups for 168 hours.
AGENT_HQ_BACKUP_RETAIN_HOURS=168 ~/agent-hq/scripts/backup-db.sh --verify
```

The backup script prunes local files matching `agent-hq_YYYY-MM-DD_HH-MM.db` after each successful backup. It only deletes matching files inside the configured backup directory, always keeps the newest matching backup, and logs every pruned, retained, or skipped file.

Useful environment overrides:

```bash
# Keep local backups for 14 days instead of the 7-day default
AGENT_HQ_BACKUP_RETAIN_HOURS=336 ~/agent-hq/scripts/backup-db.sh --verify

# Warn when the backup volume has less than 10 GB free
AGENT_HQ_BACKUP_MIN_FREE_MB=10240 ~/agent-hq/scripts/backup-db.sh
```

---

## Restore Procedure

### Step 0 — Identify the backup to restore

**From local backups:**
```bash
ls -lht ~/agent-hq/backups/
```

Pick the most recent file before the incident (format: `agent-hq_YYYY-MM-DD_HH-MM.db`).

**From GitHub (if local backups are gone):**
```bash
cd ~/agent-hq-backups
git pull origin main
ls -la YYYY-MM-DD/      # replace with the date you want
```

Download the `.db.gz` file you want:
```bash
# Copy to restore working area
cp YYYY-MM-DD/agent-hq_YYYY-MM-DD_HH-MM.db.gz /tmp/
cd /tmp && gunzip agent-hq_YYYY-MM-DD_HH-MM.db.gz
```

---

### Step 1 — Stop the API

```bash
pm2 stop agent-hq-api
```

Verify it stopped:
```bash
pm2 list | grep agent-hq-api
# Should show "stopped"
```

---

### Step 2 — Preserve the current (broken) database

```bash
# Rename the current DB so you can recover it if needed
mv ~/.agent-hq/agent-hq.db ~/.agent-hq/agent-hq.db.broken-$(date +%Y%m%d%H%M)
```

---

### Step 3 — Restore the backup

**From local backup:**
```bash
cp ~/agent-hq/backups/agent-hq_YYYY-MM-DD_HH-MM.db \
   ~/.agent-hq/agent-hq.db
```

**From GitHub (decompressed in Step 0):**
```bash
cp /tmp/agent-hq_YYYY-MM-DD_HH-MM.db \
   ~/.agent-hq/agent-hq.db
```

---

### Step 4 — Verify the restored database

```bash
sqlite3 ~/.agent-hq/agent-hq.db "SELECT COUNT(*) FROM tasks;"
sqlite3 ~/.agent-hq/agent-hq.db "SELECT COUNT(*) FROM agents;"
sqlite3 ~/.agent-hq/agent-hq.db \
  "SELECT title, status FROM tasks ORDER BY created_at DESC LIMIT 10;"
```

Expected: task count should be non-zero and close to expected operational value (700+ in production as of April 2026).

---

### Step 5 — Restart the API

```bash
pm2 start agent-hq-api
```

Wait a few seconds, then check it came up healthy:
```bash
pm2 list | grep agent-hq-api
curl -s http://localhost:3501/api/v1/tasks?limit=5 | head -c 300
```

---

### Step 6 — Confirm in the UI

Open `http://localhost:3500` and verify:
- Tasks board shows expected tasks
- Projects and sprints are visible
- No database errors in PM2 logs: `pm2 logs agent-hq-api --lines 20`

---

## What Went Wrong in April 2026

On 2026-04-04, the API restarted against an empty `agent-hq.db` file after a merge operation. All 700+ task records were lost. No backup existed at the time.

**Root cause:** no backup infrastructure, and the API initializes a fresh SQLite schema on startup if it finds a valid (but empty) DB file.

**Prevention (now in place):**
- Backups once every 24 hours to `~/agent-hq/backups/` (local)
- Each backup is pushed to a private off-machine repository when `~/agent-hq-backups/` is present; if that directory is missing, the script skips the off-machine push and logs a warning
- 7-day / 168-hour local retention enforced by the backup script by default
- Script uses file mtime to prune local backups older than `AGENT_HQ_BACKUP_RETAIN_HOURS`, while preserving the newest backup
- Script uses `sqlite3 .backup` for crash-safe snapshots

---

## Monitoring

Backup success/failure is written to:
- **launchd scheduler log:** `~/agent-hq/logs/backup-launchd.log`
- **Script log:** `~/agent-hq/logs/backup.log`

To view recent backup status:
```bash
tail -30 ~/agent-hq/logs/backup-launchd.log
tail -30 ~/agent-hq/logs/backup.log
```

A successful backup entry looks like:
```
[2026-04-04 20:00:00] [INFO] === Agent HQ Backup COMPLETE ===
[2026-06-02 02:00:00] [INFO] Backup: agent-hq_2026-06-02_02-00.db | Size: 1.1G | Retained locally for 168h | Off-machine: not configured
```

If the scheduler log is stale (last successful scheduled entry is more than 24 hours old), launchd may not be running the job. Check:
```bash
launchctl list | grep 'com.atlas-hq.backup'
plutil -p ~/Library/LaunchAgents/com.atlas-hq.backup.plist
tail -60 ~/agent-hq/logs/backup-launchd.log
```

Expected scheduler shape:
```bash
Label: com.atlas-hq.backup
StartCalendarInterval: Hour = 2, Minute = 0
ProgramArguments: /bin/bash /Users/nordini/agent-hq/scripts/backup-db.sh
```

---

## Remote Backup Access

Remote repo: `<your-private-backup-repo>`

```bash
# Clone fresh copy (if local backup repo is missing)
git clone <your-private-backup-repo> ~/agent-hq-backups

# Pull latest
cd ~/agent-hq-backups && git pull origin main

# List all available backups
find ~/agent-hq-backups -name "*.db.gz" | sort
```
