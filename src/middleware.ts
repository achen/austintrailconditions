import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

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

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isValidSession(cookieValue: string): Promise<boolean> {
  const idx = cookieValue.indexOf(':');
  if (idx === -1) return false;
  const token = cookieValue.slice(0, idx);
  const storedHash = cookieValue.slice(idx + 1);
  if (!token || !storedHash) return false;
  const computed = await sha256Hex(token);
  return computed === storedHash;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isProtected(pathname) || isPublic(pathname)) {
    return NextResponse.next();
  }

  const session = request.cookies.get(SESSION_COOKIE);
  if (!session?.value || !(await isValidSession(session.value))) {
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
