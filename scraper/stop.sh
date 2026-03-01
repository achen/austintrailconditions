#!/bin/bash
# Remove the Facebook scraper cron schedule.

if crontab -l 2>/dev/null | grep -qF "scrape.js"; then
  crontab -l 2>/dev/null | grep -vF "scrape.js" | crontab -
  echo "Scraper cron removed."
else
  echo "No scraper cron found."
fi

echo "Current crontab:"
crontab -l 2>/dev/null || echo "  (empty)"
