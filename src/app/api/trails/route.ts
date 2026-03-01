import { NextRequest, NextResponse } from 'next/server';
import * as TrailService from '@/services/trail-service';

/**
 * GET /api/trails
 * List all active (non-archived) trails.
 * Requirements: 6.1
 */
export async function GET() {
  try {
    const trails = await TrailService.listActive();
    return NextResponse.json(trails, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to list trails: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/trails
 * Create a new trail.
 * Requirements: 6.1
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const trail = await TrailService.create(body);
    return NextResponse.json(trail, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create trail: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
