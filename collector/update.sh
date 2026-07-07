#!/bin/bash
# ==============================================
# Daily auto-update script — run via cron at 3 AM
# Crontab entry:
#   0 3 * * * /opt/ticket-collector/update.sh >> /opt/ticket-collector/logs/update.log 2>&1
# ==============================================

cd "$(dirname "$0")"

echo "$(date) — Checking for updates..."

# Capture current baileys version
OLD_VERSION=$(node -e "console.log(require('@whiskeysockets/baileys/package.json').version)" 2>/dev/null)

# Update dependencies
npm update 2>&1

# Capture new version
NEW_VERSION=$(node -e "console.log(require('@whiskeysockets/baileys/package.json').version)" 2>/dev/null)

if [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
    echo "$(date) — Baileys updated: $OLD_VERSION → $NEW_VERSION"
    echo "$(date) — Restarting collector..."
    pm2 restart ticket-collector
    echo "$(date) — Restart complete"
else
    echo "$(date) — No updates available (Baileys $OLD_VERSION)"
fi
