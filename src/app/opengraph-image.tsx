import { ImageResponse } from 'next/og';
import { sql } from '@/lib/db';

export const runtime = 'edge';
export const revalidate = 300; // regenerate every 5 minutes
export const contentType = 'image/png';
export const size = { width: 1200, height: 630 };

export default async function OGImage() {
  const { rows } = await sql`
    SELECT name, condition_status
    FROM trails
    WHERE is_archived = false AND updates_enabled = true
    ORDER BY name ASC
  `;

  const trails = rows.map(r => ({
    name: r.name as string,
    status: r.condition_status as string,
  }));

  const green = ['Observed Dry', 'Predicted Dry', 'Open'];
  const dryCount = trails.filter(t => green.includes(t.status)).length;
  const wetCount = trails.length - dryCount;

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          backgroundColor: '#111827',
          padding: '40px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ fontSize: '42px', fontWeight: 'bold', color: '#ffffff' }}>
            Austin Trail Conditions
          </div>
          <div style={{ display: 'flex', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#16a34a' }} />
              <span style={{ color: '#9ca3af', fontSize: '20px' }}>{dryCount} rideable</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#dc2626' }} />
              <span style={{ color: '#9ca3af', fontSize: '20px' }}>{wetCount} wet</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', flex: 1 }}>
          {trails.map((trail) => {
            const isGreen = green.includes(trail.status);
            return (
              <div
                key={trail.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  backgroundColor: isGreen ? '#16a34a' : '#dc2626',
                  color: '#ffffff',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '16px',
                  fontWeight: 500,
                }}
              >
                {trail.name}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '16px' }}>
          <span style={{ color: '#6b7280', fontSize: '16px' }}>austintrailconditions.com</span>
          <span style={{ color: '#6b7280', fontSize: '16px' }}>
            Updated {new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}
          </span>
        </div>
      </div>
    ),
    { ...size }
  );
}
