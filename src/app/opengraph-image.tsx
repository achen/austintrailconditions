import { ImageResponse } from 'next/og';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const revalidate = 300;
export const contentType = 'image/png';
export const size = { width: 600, height: 1200 };

export default async function OGImage() {
  const { rows } = await sql`
    SELECT
      t.name,
      t.condition_status,
      COALESCE(
        (p.input_data->>'remainingMoistureIn')::numeric,
        (p.input_data->>'totalPrecipitationIn')::numeric
      ) AS remaining_moisture_in
    FROM trails t
    LEFT JOIN LATERAL (
      SELECT input_data
      FROM predictions
      WHERE trail_id = t.id
      ORDER BY created_at DESC
      LIMIT 1
    ) p ON t.condition_status = 'Predicted Wet'
    WHERE t.is_archived = false AND t.updates_enabled = true
    ORDER BY t.name ASC
  `;

  const trails = rows.map(r => ({
    name: r.name as string,
    status: r.condition_status as string,
    moisture: r.remaining_moisture_in != null ? Number(r.remaining_moisture_in) : null,
  }));

  const greenStatuses = ['Observed Dry', 'Predicted Dry', 'Open'];

  return new ImageResponse(
    (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#f9fafb',
      }}>
        <div style={{
          display: 'flex',
          backgroundColor: '#ffffff',
          padding: '16px 20px',
          borderBottom: '1px solid #e5e7eb',
        }}>
          <span style={{ fontSize: '24px', fontWeight: 'bold', color: '#111827' }}>
            Austin Trail Conditions
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {trails.map((trail) => {
            const isGreen = greenStatuses.includes(trail.status);
            const bg = isGreen ? '#16a34a' : '#dc2626';
            const isDrying = trail.status === 'Predicted Wet';
            return (
              <div
                key={trail.name}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  backgroundColor: bg,
                  padding: '10px 20px',
                  borderBottom: '1px solid rgba(255,255,255,0.15)',
                }}
              >
                <span style={{ color: '#ffffff', fontSize: '18px', fontWeight: 500 }}>
                  {trail.name}
                </span>
                <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: '14px' }}>
                  {trail.status}
                  {isDrying && trail.moisture != null ? ` · ${trail.moisture.toFixed(2)} in left` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    ),
    { ...size }
  );
}
