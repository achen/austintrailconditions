import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * PATCH /api/admin/trails/[id] — update max absorbable and max drying days
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const updates: string[] = [];
  const hasMaxAbsorbable = 'maxAbsorbableIn' in body;
  const hasMaxDryingDays = 'maxDryingDays' in body;

  if (!hasMaxAbsorbable && !hasMaxDryingDays) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const result = await sql`
    UPDATE trails
    SET
      drying_rate_in_per_day = CASE WHEN ${hasMaxAbsorbable} THEN ${body.maxAbsorbableIn ?? null}::numeric ELSE drying_rate_in_per_day END,
      max_drying_days = CASE WHEN ${hasMaxDryingDays} THEN ${body.maxDryingDays ?? null}::integer ELSE max_drying_days END,
      updated_at = now()
    WHERE id = ${id}
    RETURNING id, name, drying_rate_in_per_day AS max_absorbable_in, max_drying_days
  `;

  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Trail not found' }, { status: 404 });
  }

  return NextResponse.json(result.rows[0]);
}
