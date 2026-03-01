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
 */
export async function notifyRainDetected(
  eventsCreated: number,
  totalPrecipitation: number
): Promise<boolean> {
  return sendAlert(
    `Rain detected — ${eventsCreated} new event(s)`,
    `<h3>Rain Detected</h3>
     <p><strong>${eventsCreated}</strong> new rain event(s) created.</p>
     <p>Total precipitation: <strong>${totalPrecipitation.toFixed(2)}"</strong></p>
     <p>Trail predictions will be updated on the next prediction cycle.</p>`
  );
}
