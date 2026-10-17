import { NextResponse } from 'next/server';
import { startAutoBackup } from '@/lib/backup';
import { startStakeholderUpdates } from '@/lib/stakeholders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Pinged by server.js at start-up so the automatic backup and the stakeholder
// update emails run even before anyone opens the planner.
export async function GET() {
  startAutoBackup();
  startStakeholderUpdates();
  return NextResponse.json({ ok: true });
}
