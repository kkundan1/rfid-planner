import { NextResponse } from 'next/server';
import { currentUser, hashPassword, newSalt, ITER, touchSession } from '@/lib/auth';
import { getDoc, setDoc } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A signed-in person changes their own password. Admins can still see it (pwvault), as agreed.
export async function POST(req) {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request.' }, { status: 400 }); }
  const current = String((body && body.current) || '');
  const next = String((body && body.next) || '');
  const c = getDoc('creds', user.id);
  if (!c || !c.salt || !c.hash) return NextResponse.json({ error: 'Your account has no password login yet. Ask an admin to set one.' }, { status: 400 });
  if (hashPassword(current, c.salt, c.iter || ITER) !== c.hash) return NextResponse.json({ error: 'Your current password is not correct.' }, { status: 403 });
  if (next.length < 8 || next.length > 128) return NextResponse.json({ error: 'The new password must be 8 to 128 characters.' }, { status: 400 });
  if (next === current) return NextResponse.json({ error: 'The new password is the same as the current one.' }, { status: 400 });
  const salt = newSalt();
  const now = Date.now();
  setDoc('creds', user.id, { ...c, salt, hash: hashPassword(next, salt), iter: ITER, setAt: now, setBy: user.id });
  setDoc('pwvault', user.id, { pw: next, setAt: now, setBySelf: true });
  touchSession(user.token); // stay signed in here; other devices are signed out
  return NextResponse.json({ ok: true });
}
