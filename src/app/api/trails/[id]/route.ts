import { NextRequest, NextResponse } from 'next/server';
import * as TrailService from '@/services/trail-service';

/**
 * PUT /api/trails/[id]
 * Update an existing trail by ID.
 * Requirements: 6.2, 6.3
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const trail = await TrailService.update(id, body);
    return NextResponse.json(trail, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to update trail: ${message}`);
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * DELETE /api/trails/[id]
 * Archive a trail by ID (soft delete).
 * Requirements: 6.4
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const trail = await TrailService.archive(id);
    return NextResponse.json(trail, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to archive trail: ${message}`);
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
