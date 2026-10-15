import { NextResponse } from 'next/server';
import { currentUser, ownerId, userName } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const u = currentUser();
  if (!u) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  return NextResponse.json({ id: u.id, role: u.role, name: userName(u.id), isOwner: u.id === ownerId(), canEdit: u.role === 'admin' });
}
