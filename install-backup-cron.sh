#!/usr/bin/env bash
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRON="0 3 * * * cd $PROJECT_DIR && /usr/bin/node backup-wallet.js >> $PROJECT_DIR/backups/backup.log 2>&1"
mkdir -p "$PROJECT_DIR/backups"
( crontab -l 2>/dev/null | grep -v 'backup-wallet.js' ; echo "$CRON" ) | crontab -
echo "✅ Backup diário configurado para 03:00."
