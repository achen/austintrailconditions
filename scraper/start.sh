#!/bin/bash
# Install the cron schedule for the Facebook scraper.
# Runs every 2 hours from 6am–8pm Central Time.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found. Make sure Node.js is installed and in your PATH."
  exit 1
fi

CRON_LINE="0 6,8,10,12,14,16,18,20 * * * export DISPLAY=:0 && cd $SCRIPT_DIR && $NODE_BIN scrape.js >> $SCRIPT_DIR/scrape.log 2>&1"

# Check if already installed
if crontab -l 2>/dev/null | grep -qF "scrape.js"; then
  echo "Scraper cron is already installed. Updating..."
  crontab -l 2>/dev/null | grep -vF "scrape.js" | { cat; echo "$CRON_LINE"; } | crontab -
else
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
fi

echo "Cron installed:"
echo "  $CRON_LINE"
echo ""
echo "Scraper will run every 2h from 6am–8pm."
echo "Logs: $SCRIPT_DIR/scrape.log"
echo ""
echo "To verify: crontab -l"
