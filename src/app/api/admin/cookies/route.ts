import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * POST /api/admin/cookies
 *
 * Update Facebook cookies used for scraping.
 * Stores in a simple key-value config table so it persists across deploys
 * without needing to update Vercel env vars.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const cookies = body.cookies as string;

    if (!cookies || typeof cookies !== 'string') {
      return NextResponse.json({ error: 'Missing cookies string' }, { status: 400 });
    }

    // Basic validation — must contain c_user and xs at minimum
    if (!cookies.includes('c_user') || !cookies.includes('xs')) {
      return NextResponse.json(
        { error: 'Invalid cookies — must contain at least c_user and xs values' },
        { status: 400 }
      );
    }

    // Ensure config table exists
    await sql`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    // Upsert the cookie value
    await sql`
      INSERT INTO app_config (key, value, updated_at)
      VALUES ('facebook_cookies', ${cookies}, now())
      ON CONFLICT (key) DO UPDATE SET value = ${cookies}, updated_at = now()
    `;

    return NextResponse.json({
      message: 'Cookies updated successfully. They will be used on the next Facebook scrape.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to update cookies:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/admin/cookies
 *
 * Check cookie status (not the actual value — just whether they're set and when last updated).
 */
export async function GET() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    const result = await sql`
      SELECT updated_at FROM app_config WHERE key = 'facebook_cookies'
    `;

    const envCookies = process.env.FACEBOOK_COOKIES;
    const dbRow = result.rows[0];

    return NextResponse.json({
      hasEnvCookies: !!envCookies,
      hasDbCookies: !!dbRow,
      dbCookiesUpdatedAt: dbRow?.updated_at ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
