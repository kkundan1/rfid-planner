import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { destroySession, SESSION_COOKIE } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  destroySession(cookies().get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
