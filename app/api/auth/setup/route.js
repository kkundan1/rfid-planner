import { NextResponse } from 'next/server';
import { needsSetup, createAccount, createSession, SESSION_COOKIE, cookieOptions, newId } from '@/lib/auth';
import { setDoc } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ needsSetup: needsSetup() });
}

// Creates the first admin (owner) account. Works only while no owner exists.
export async function POST(req) {
  if (!needsSetup()) return NextResponse.json({ error: 'Setup is already complete.' }, { status: 403 });
  let b = {};
  try { b = await req.json(); } catch {}
  const name = String(b.name || '').trim(), loginId = String(b.loginId || '').trim(), pw = String(b.password || '');
  if (!name) return NextResponse.json({ error: 'Enter your name.' }, { status: 400 });
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(loginId)) return NextResponse.json({ error: 'Login ID must be 3–32 letters, digits, dots, dashes or underscores.' }, { status: 400 });
  if (pw.length < 8) return NextResponse.json({ error: 'The password needs at least 8 characters.' }, { status: 400 });
  const memberId = newId('m');
  setDoc('members', memberId, { name, role: 'Admin', hue: 0, order: Date.now() });
  const uid = createAccount({ loginId, password: pw, role: 'admin', memberId });
  setDoc('settings', 'owner', { userId: uid });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSession(uid), cookieOptions());
  return res;
}
