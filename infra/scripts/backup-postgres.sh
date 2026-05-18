#!/usr/bin/env bash
# Capflow Postgres backup script (F1).
#
# Schedule via cron/systemd timer:
#   0 3 * * * /srv/capflow/infra/scripts/backup-postgres.sh
#
# Behavior:
#   - pg_dump to gzip-compressed file
#   - rotate older than $RETENTION_DAYS (default 14)
#   - upload to S3/B2 if $BACKUP_REMOTE_URL set (via rclone)
#
# Environment (typically /etc/capflow/backup.env):
#   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_DB
#   PGPASSWORD (recommended — avoid prompt)
#   BACKUP_DIR             default /var/backups/capflow
#   RETENTION_DAYS         default 14
#   BACKUP_REMOTE_URL      optional, e.g. "s3:capflow-backups/postgres"

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/capflow}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-capflow}"
POSTGRES_DB="${POSTGRES_DB:-capflow}"

mkdir -p "$BACKUP_DIR"

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="$BACKUP_DIR/capflow-$TS.sql.gz"

echo "[backup] dumping $POSTGRES_DB to $OUT ..."

pg_dump \
  --host="$POSTGRES_HOST" \
  --port="$POSTGRES_PORT" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --format=plain \
  --no-owner \
  --no-acl \
  | gzip -9 > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] done: $OUT ($SIZE)"

# Rotate local backups.
echo "[backup] rotating > $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name 'capflow-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete

# Optional remote upload (S3/B2/etc).
if [[ -n "${BACKUP_REMOTE_URL:-}" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[backup] uploading to $BACKUP_REMOTE_URL ..."
    rclone copy "$OUT" "$BACKUP_REMOTE_URL/" --progress
  else
    echo "[backup] rclone не установлен; пропускаем upload" >&2
  fi
fi

echo "[backup] OK"
