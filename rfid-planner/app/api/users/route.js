import { NextResponse } from 'next/server';
import { currentUser, userName } from '@/lib/auth';
import { listDocs } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Display names for user ids (history, updates, accounts).
export async function POST(req) {
  if (!currentUser()) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  let b = {};
  try { b = await req.json(); } catch {}
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
  const out = {};
  for (const id of ids) out[id] = { name: typeof id === 'string' ? userName(id) : '' };
  return NextResponse.json(out);
}

// Accounts list for pickers.
export async function GET(req) {
  if (!currentUser()) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  const q = (new URL(req.url).searchParams.get('q') || '').toLowerCase();
  const list = listDocs('access').map((a) => ({ id: a.id, name: userName(a.id) })).filter((x) => !q || x.name.toLowerCase().includes(q));
  return NextResponse.json(list.slice(0, 8));
}
