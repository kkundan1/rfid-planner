import { NextResponse } from 'next/server';
import { verifyLogin, userRole, createSession, SESSION_COOKIE, cookieOptions } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const attempts = new Map(); // simple per-IP throttle

export async function POST(req) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return NextResponse.json({ error: `Too many attempts. Try again in ${Math.ceil((a.until - Date.now()) / 1000)} seconds.` }, { status: 429 });
  let body = {};
  try { body = await req.json(); } catch {}
  const uid = verifyLogin(body.loginId, body.password || '');
  if (!uid) {
    a.n += 1; if (a.n >= 5) { a.until = Date.now() + 30000; a.n = 0; } attempts.set(ip, a);
    return NextResponse.json({ error: 'Login ID or password is incorrect.' }, { status: 401 });
  }
  attempts.delete(ip);
  const role = userRole(uid);
  if (role === 'disabled') return NextResponse.json({ error: 'Your account is disabled. Contact your R&D manager.' }, { status: 403 });
  if (role === 'none') return NextResponse.json({ error: 'This login has no access to the planner yet. Ask an admin.' }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSession(uid), { ...cookieOptions(), maxAge: body.keep ? 7 * 86400 : undefined });
  return res;
}
