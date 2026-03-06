import { Resend } from 'resend';

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'info@austintrailconditions.com';
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';

function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key || !ALERT_EMAIL) return null;
  return new Resend(key);
}

/**
 * Send an alert email. Silently logs on failure — alerts should never crash cron jobs.
 */
async function sendAlert(subject: string, html: string): Promise<boolean> {
  const client = getClient();
  if (!client) {
    console.warn('Notification skipped: RESEND_API_KEY or ALERT_EMAIL not configured');
    return false;
  }

  try {
    await client.emails.send({
      from: FROM_EMAIL,
      to: ALERT_EMAIL,
      subject: `[Trail Conditions] ${subject}`,
      html,
    });
    return true;
  } catch (err) {
    console.error('Failed to send alert email:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Alert when weather stations are offline (returning 204/no data).
 */
export async function notifyStationsDown(
  offlineStations: string[],
  totalStations: number
): Promise<boolean> {
  if (offlineStations.length === 0) return false;

  const pct = Math.round((offlineStations.length / totalStations) * 100);
  return sendAlert(
    `${offlineStations.length}/${totalStations} weather stations offline (${pct}%)`,
    `<h3>Offline Weather Stations</h3>
     <p>${offlineStations.length} of ${totalStations} stations returned no data:</p>
     <ul>${offlineStations.map((s) => `<li>${s}</li>`).join('')}</ul>
     <p style="color:#888;font-size:12px">This may be normal for personal weather stations that go offline periodically.</p>`
  );
}

/**
 * Alert when a cron job fails.
 */
export async function notifyCronFailure(
  cronName: string,
  error: string
): Promise<boolean> {
  return sendAlert(
    `Cron failure: ${cronName}`,
    `<h3>Cron Job Failed: ${cronName}</h3>
     <p><strong>Error:</strong></p>
     <pre style="background:#f5f5f5;padding:12px;border-radius:4px">${error}</pre>`
  );
}

/**
 * Alert when rain is detected — informational, so you know the system is working.
 * Includes current trail statuses.
 */
export async function notifyRainDetected(
  eventsCreated: number,
  totalPrecipitation: number,
  trailStatuses?: Array<{ name: string; status: string; rainAccum?: number }>
): Promise<boolean> {
  const trailTable = trailStatuses && trailStatuses.length > 0
    ? `<h3>Current Trail Statuses</h3>
       <table style="border-collapse:collapse;font-size:14px">
         <tr style="background:#f0f0f0"><th style="padding:4px 8px;text-align:left">Trail</th><th style="padding:4px 8px;text-align:left">Status</th><th style="padding:4px 8px;text-align:right">Rain Accum</th></tr>
         ${trailStatuses.map(t => `<tr><td style="padding:4px 8px">${t.name}</td><td style="padding:4px 8px">${t.status}</td><td style="padding:4px 8px;text-align:right">${t.rainAccum != null ? t.rainAccum.toFixed(2) + '"' : '—'}</td></tr>`).join('')}
       </table>`
    : '';

  return sendAlert(
    `Rain detected — ${eventsCreated} new event(s)`,
    `<h3>Rain Detected</h3>
     <p><strong>${eventsCreated}</strong> new rain event(s) created.</p>
     <p>Total precipitation: <strong>${totalPrecipitation.toFixed(2)}"</strong></p>
     <p>Trail predictions will be updated on the next prediction cycle.</p>
     ${trailTable}`
  );
}

/**
 * Alert when Facebook cookies have expired and need refreshing.
 * Includes a link to the admin cookie update page.
 */
export async function notifyCookieExpired(): Promise<boolean> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3002';

  return sendAlert(
    'Facebook cookies expired — action required',
    `<h3>Facebook Cookies Expired</h3>
     <p>The Facebook scraper received a login page instead of group posts. Your cookies need to be refreshed.</p>
     <h4>How to fix:</h4>
     <ol>
       <li>Open Facebook in Chrome and make sure you're logged in</li>
       <li>Open DevTools (F12) → Application → Cookies → facebook.com</li>
       <li>Copy the cookie string (or use the Cookie-Editor extension to export)</li>
       <li><a href="${siteUrl}/admin/cookies">Click here to paste your new cookies</a></li>
     </ol>
     <p style="color:#888;font-size:12px">Cookies typically expire every ~90 days.</p>`
  );
}
/**
 * Alert when the Weather Underground API returns 401/403 (key locked or revoked).
 */
export async function notifyWeatherApiAccessDenied(
  statusCode: number,
  stationOrEndpoint: string
): Promise<boolean> {
  return sendAlert(
    `Weather API access denied (HTTP ${statusCode}) — key may be locked`,
    `<h3>Weather API Access Denied</h3>
     <p>The Weather Underground API returned <strong>HTTP ${statusCode}</strong> when calling:</p>
     <pre style="background:#f5f5f5;padding:12px;border-radius:4px">${stationOrEndpoint}</pre>
     <p>This usually means the API key has been rate-limited or revoked. All weather API calls have been halted to prevent further lockout.</p>
     <h4>What to do:</h4>
     <ol>
       <li>Check your <a href="https://www.wunderground.com/member/api-keys">Weather Underground API keys page</a></li>
       <li>If the key is locked, wait for it to reset or generate a new one</li>
       <li>Update WEATHER_API_KEY in your Vercel environment variables if needed</li>
     </ol>`
  );
}
/**
 * Daily forecast check notification — shows forecast result and current trail statuses.
 */
export async function notifyForecastCheck(
  rainExpected: boolean,
  maxChance: number,
  details: string,
  trailStatuses: Array<{ name: string; status: string }>,
  mode: string
): Promise<boolean> {
  const emoji = rainExpected ? '🌧️' : '☀️';
  const modeLabel = rainExpected ? 'Hourly station polling activated' : `Midday-only polling (${mode})`;

  const trailTable = trailStatuses.length > 0
    ? `<table style="border-collapse:collapse;font-size:14px">
         <tr style="background:#f0f0f0"><th style="padding:4px 8px;text-align:left">Trail</th><th style="padding:4px 8px;text-align:left">Status</th></tr>
         ${trailStatuses.map(t => `<tr><td style="padding:4px 8px">${t.name}</td><td style="padding:4px 8px">${t.status}</td></tr>`).join('')}
       </table>`
    : '';

  return sendAlert(
    `${emoji} Forecast: ${rainExpected ? 'Rain expected' : 'No rain'} (${maxChance >= 0 ? maxChance + '%' : 'unknown'})`,
    `<h3>${emoji} Daily Forecast Check</h3>
     <p><strong>Rain expected:</strong> ${rainExpected ? 'Yes' : 'No'}</p>
     <p><strong>Max precip chance:</strong> ${maxChance >= 0 ? maxChance + '%' : 'API error'}</p>
     <p><strong>Details:</strong> ${details}</p>
     <p><strong>Mode:</strong> ${modeLabel}</p>
     <h3>Current Trail Statuses</h3>
     ${trailTable}`
  );
}



