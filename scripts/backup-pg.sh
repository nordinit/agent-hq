#!/usr/bin/env bash
# =============================================================================
# Agent HQ PostgreSQL Backup
# =============================================================================
# Backs up the production PostgreSQL database (the system of record since the
# 2026-07-29 cutover) to a local directory with retention.
#
# Replaces scripts/backup-db.sh, which backed up the SQLite file at
# AGENT_HQ_DB_PATH. That file has been frozen since the cutover, so the nightly
# job was producing identical copies of a database production no longer writes
# to while PostgreSQL went unbacked. See docs/postgres-only-migration-spec.md.
#
# Usage:
#   ./scripts/backup-pg.sh              # backup + archive integrity check
#   ./scripts/backup-pg.sh --verify     # the above, plus a real restore into a
#                                       # scratch database, row counts compared
#                                       # against the source, then dropped
#
# Logs:     $AGENT_HQ_LOG_DIR/backup.log  (default <repo>/logs/backup.log)
# Schedule: daily 02:00 via launchd job com.atlas-hq.backup
#
# Unlike backup-db.sh this script is version controlled. It holds no secrets and
# every path is an overridable default — and a backup script that exists only on
# the machine being backed up is not a recovery plan.
# =============================================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
REPO_DIR="${AGENT_HQ_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
PG_BIN="${AGENT_HQ_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
DB_NAME="${AGENT_HQ_PG_DATABASE:-agent_hq_prod}"
BACKUP_DIR="${AGENT_HQ_PG_BACKUP_DIR:-$REPO_DIR/backups/pg}"
LOG_DIR="${AGENT_HQ_LOG_DIR:-$REPO_DIR/logs}"
LOG_FILE="$LOG_DIR/backup.log"
RETAIN_HOURS="${AGENT_HQ_BACKUP_RETAIN_HOURS:-168}"
MIN_FREE_MB="${AGENT_HQ_BACKUP_MIN_FREE_MB:-5120}"
VERIFY="${1:-}"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M)
BACKUP_FILENAME="agent-hq-pg_${TIMESTAMP}.dump"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILENAME"

# Tables whose counts are compared source-to-restore under --verify. Operational
# core first: a restore that loses routing config is as dead as one that loses tasks.
VERIFY_TABLES=(tasks projects agents sprints sprint_task_transitions sprint_task_routing_rules sprint_task_transition_requirements)

# ── Helpers ─────────────────────────────────────────────────────────────────
log() {
  local level="$1"; shift
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*" | tee -a "$LOG_FILE"
}

die() {
  log ERROR "$*"
  exit 1
}

get_mtime_epoch() {
  local file="$1"
  if stat -f %m "$file" >/dev/null 2>&1; then stat -f %m "$file"; else stat -c %Y "$file"; fi
}

resolve_dir() { (cd "$1" 2>/dev/null && pwd -P); }

resolve_path() {
  local dir base
  dir=$(dirname "$1"); base=$(basename "$1")
  (cd "$dir" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$base")
}

validate_positive_int() {
  [[ "$2" =~ ^[0-9]+$ ]] || die "$1 must be a positive integer, got: $2"
  (( $2 > 0 )) || die "$1 must be greater than zero"
}

# ── Pre-flight ──────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR" "$LOG_DIR"

[[ -x "$PG_BIN/pg_dump" ]]    || die "pg_dump not found at $PG_BIN/pg_dump"
[[ -x "$PG_BIN/pg_restore" ]] || die "pg_restore not found at $PG_BIN/pg_restore"
[[ -x "$PG_BIN/psql" ]]       || die "psql not found at $PG_BIN/psql"
validate_positive_int "AGENT_HQ_BACKUP_RETAIN_HOURS" "$RETAIN_HOURS"
validate_positive_int "AGENT_HQ_BACKUP_MIN_FREE_MB" "$MIN_FREE_MB"

"$PG_BIN/psql" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1 \
  || die "Cannot connect to database '$DB_NAME'"

DB_SIZE=$("$PG_BIN/psql" -d "$DB_NAME" -tAc "SELECT pg_size_pretty(pg_database_size('$DB_NAME'))")

log INFO "=== Agent HQ PostgreSQL Backup START ==="
log INFO "Source: $DB_NAME ($DB_SIZE)"
log INFO "Target: $BACKUP_PATH"
log INFO "Local retention: ${RETAIN_HOURS}h; min free-space warning: ${MIN_FREE_MB}MB"

FREE_MB=$(df -Pm "$BACKUP_DIR" | awk 'NR == 2 {print $4}')
if [[ "$FREE_MB" =~ ^[0-9]+$ ]] && (( FREE_MB < MIN_FREE_MB )); then
  log WARN "Backup volume free space is below threshold: ${FREE_MB}MB available, threshold ${MIN_FREE_MB}MB"
fi

# ── 1. Dump ─────────────────────────────────────────────────────────────────
# Custom format: compressed, restorable selectively, and readable by pg_restore -l
# without a database, which is what makes the integrity check below cheap.
"$PG_BIN/pg_dump" --format=custom --compress=9 --file="$BACKUP_PATH" "$DB_NAME" \
  || die "pg_dump failed"

BACKUP_SIZE=$(du -sh "$BACKUP_PATH" | cut -f1)
log INFO "Backup created: $BACKUP_PATH ($BACKUP_SIZE)"

# ── 2. Archive integrity (every run, not just --verify) ─────────────────────
# A truncated or corrupt archive is the failure that looks like success. Reading
# the table of contents costs a second and catches it immediately.
TOC_ENTRIES=$("$PG_BIN/pg_restore" --list "$BACKUP_PATH" 2>/dev/null | grep -c '^[0-9]' || true)
[[ "$TOC_ENTRIES" =~ ^[0-9]+$ ]] && (( TOC_ENTRIES > 0 )) \
  || die "Archive integrity check FAILED — pg_restore could not read a table of contents from $BACKUP_PATH"
log INFO "Archive integrity OK — $TOC_ENTRIES entries in the table of contents"

# ── 3. Retention ────────────────────────────────────────────────────────────
PRUNED=0; RETAINED=0; SKIPPED=0
CUTOFF_EPOCH=$(( $(date +%s) - RETAIN_HOURS * 3600 ))
BACKUP_DIR_REAL=$(resolve_dir "$BACKUP_DIR") || die "Could not resolve backup directory: $BACKUP_DIR"
NEWEST_BACKUP=""; NEWEST_MTIME=0

for candidate in "$BACKUP_DIR"/agent-hq-pg_*.dump; do
  [[ -e "$candidate" ]] || continue
  [[ "$(basename "$candidate")" =~ ^agent-hq-pg_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}\.dump$ ]] || {
    log WARN "Skipping unexpected backup filename during retention: $candidate"
    SKIPPED=$((SKIPPED + 1)); continue
  }
  FILE_MTIME=$(get_mtime_epoch "$candidate")
  if (( FILE_MTIME > NEWEST_MTIME )); then NEWEST_MTIME="$FILE_MTIME"; NEWEST_BACKUP="$candidate"; fi
done

for old_file in "$BACKUP_DIR"/agent-hq-pg_*.dump; do
  [[ -e "$old_file" ]] || continue
  [[ "$(basename "$old_file")" =~ ^agent-hq-pg_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}\.dump$ ]] || continue

  # Never delete outside the configured directory, whatever a symlink claims.
  old_file_real=$(resolve_path "$old_file") || die "Could not resolve backup path: $old_file"
  [[ "$(dirname "$old_file_real")" == "$BACKUP_DIR_REAL" ]] \
    || die "Refusing to prune backup outside configured directory: $old_file"

  if (( $(get_mtime_epoch "$old_file") < CUTOFF_EPOCH )); then
    if [[ "$old_file" == "$NEWEST_BACKUP" ]]; then
      log INFO "Retained newest backup despite age: $old_file"
      RETAINED=$((RETAINED + 1)); continue
    fi
    rm -f "$old_file"
    log INFO "Pruned old backup: $old_file"
    PRUNED=$((PRUNED + 1))
  else
    RETAINED=$((RETAINED + 1))
  fi
done

log INFO "Retention: pruned $PRUNED, retained $RETAINED, skipped $SKIPPED unexpected; window ${RETAIN_HOURS}h"

# ── 4. Restore verification ─────────────────────────────────────────────────
# Restores into a scratch database and compares row counts against the source.
# "The dump file exists" is not evidence it restores; this is.
if [[ "$VERIFY" == "--verify" ]]; then
  SCRATCH_DB="agent_hq_restore_verify_$$"
  log INFO "Restore verification: restoring into $SCRATCH_DB"

  cleanup_scratch() {
    "$PG_BIN/dropdb" --if-exists "$SCRATCH_DB" 2>/dev/null || true
  }
  trap cleanup_scratch EXIT

  "$PG_BIN/createdb" "$SCRATCH_DB" || die "Could not create scratch database $SCRATCH_DB"
  # --exit-on-error so a partial restore is a failure, not a warning we skim past.
  "$PG_BIN/pg_restore" --dbname="$SCRATCH_DB" --exit-on-error "$BACKUP_PATH" \
    || die "Restore verification FAILED — pg_restore could not load $BACKUP_PATH"

  MISMATCHES=0
  for table in "${VERIFY_TABLES[@]}"; do
    SRC=$("$PG_BIN/psql" -d "$DB_NAME"    -tAc "SELECT count(*) FROM $table" 2>/dev/null || echo "error")
    DST=$("$PG_BIN/psql" -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM $table" 2>/dev/null || echo "error")
    if [[ "$SRC" == "$DST" && "$SRC" =~ ^[0-9]+$ ]]; then
      log INFO "  $table: $SRC rows — match"
    else
      log ERROR "  $table: source=$SRC restored=$DST — MISMATCH"
      MISMATCHES=$((MISMATCHES + 1))
    fi
  done

  cleanup_scratch
  trap - EXIT

  (( MISMATCHES == 0 )) || die "Restore verification FAILED — $MISMATCHES table(s) did not match"
  log INFO "Restore verification PASSED — ${#VERIFY_TABLES[@]} tables matched source counts"
fi

log INFO "=== Agent HQ PostgreSQL Backup COMPLETE ==="
log INFO "Backup: $BACKUP_FILENAME | Size: $BACKUP_SIZE | Retained locally for ${RETAIN_HOURS}h"
