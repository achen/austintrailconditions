import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'crypto';

const SESSION_COOKIE = 'admin_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * POST /api/admin/auth — login
 */
export async function POST(request: Request) {
  const body = await request.json();
  const { password } = body;

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return NextResponse.json({ error: 'ADMIN_PASSWORD not configured' }, { status: 500 });
  }

  if (password !== adminPassword) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashPassword(token);

  // Store hash in cookie, validate by re-hashing
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, `${token}:${tokenHash}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/admin/auth — logout
 */
export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}

/**
 * GET /api/admin/auth — check session
 */
export async function GET() {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE);

  if (!session?.value) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const [token, storedHash] = session.value.split(':');
  if (!token || !storedHash || hashPassword(token) !== storedHash) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({ authenticated: true });
}
