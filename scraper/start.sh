#!/bin/bash
# Install cron schedules for scrapers.
# Facebook scraper: every 2 hours from 6am–8pm Central Time.
# Reimers scraper: every 30 minutes from 6am–8pm Central Time.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found. Make sure Node.js is installed and in your PATH."
  exit 1
fi

FB_CRON="0 6,8,10,12,14,16,18,20 * * * /bin/bash -c 'cd $SCRIPT_DIR && xvfb-run -a --server-args=\"-screen 0 1440x900x24\" env HEADLESS=false $NODE_BIN scrape.js >> $SCRIPT_DIR/scrape.log 2>&1'"
REIMERS_CRON="*/30 6-20 * * * /bin/bash -c 'cd $SCRIPT_DIR && $NODE_BIN scrape-reimers.js >> $SCRIPT_DIR/scrape-reimers.log 2>&1'"

# Remove old entries and install fresh
crontab -l 2>/dev/null | grep -vF "scrape.js" | grep -vF "scrape-reimers.js" | { cat; echo "$FB_CRON"; echo "$REIMERS_CRON"; } | crontab -

echo "Crons installed:"
echo ""
echo "  Facebook (every 2h, 6am–8pm):"
echo "  $FB_CRON"
echo ""
echo "  Reimers (every 30min, 6am–8pm):"
echo "  $REIMERS_CRON"
echo ""
echo "Logs:"
echo "  $SCRIPT_DIR/scrape.log"
echo "  $SCRIPT_DIR/scrape-reimers.log"
echo ""
echo "To verify: crontab -l"
