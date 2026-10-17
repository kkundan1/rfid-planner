import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { backupStatus, runBackup, startAutoBackup } from '@/lib/backup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admins: see the automatic backups (GET) or run one now (POST).
export async function GET() {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  startAutoBackup();
  return NextResponse.json(backupStatus(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST() {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const info = await runBackup('manual');
    return NextResponse.json({ ok: true, info, ...backupStatus() });
  } catch (e) {
    return NextResponse.json({ error: 'backup_failed', message: String((e && e.message) || e), ...backupStatus() }, { status: 500 });
  }
}
