import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';

const SESSION_COOKIE = 'admin_session';

// Routes that require auth
const PROTECTED_PATHS = ['/admin', '/api/admin'];
// Login page and auth API must be accessible without auth
const PUBLIC_PATHS = ['/admin/login', '/api/admin/auth'];

function isProtected(pathname: string): boolean {
  return PROTECTED_PATHS.some((p) => pathname.startsWith(p));
}

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function isValidSession(cookieValue: string): boolean {
  const [token, storedHash] = cookieValue.split(':');
  if (!token || !storedHash) return false;
  const computed = crypto.createHash('sha256').update(token).digest('hex');
  return computed === storedHash;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isProtected(pathname) || isPublic(pathname)) {
    return NextResponse.next();
  }

  const session = request.cookies.get(SESSION_COOKIE);
  if (!session?.value || !isValidSession(session.value)) {
    // API routes get 401, pages get redirected to login
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const loginUrl = new URL('/admin/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
