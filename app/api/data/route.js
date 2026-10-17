import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { readChanges, writeDoc, Forbidden } from '@/lib/store';
import { startAutoBackup } from '@/lib/backup';
import { startStakeholderUpdates } from '@/lib/stakeholders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  startAutoBackup();
  startStakeholderUpdates();
  const since = Number(new URL(req.url).searchParams.get('since') || 0) || 0;
  return NextResponse.json(readChanges(user, since), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req) {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }); }
  const { op, c, id, data } = body || {};
  if (!['set', 'delete'].includes(op) || typeof c !== 'string' || typeof id !== 'string') return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  try {
    writeDoc(user, op, c, id, data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof Forbidden) return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    console.error(e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
