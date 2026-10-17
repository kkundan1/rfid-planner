import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { suStatus, cancelPending, runWeekly, runEvents, startStakeholderUpdates } from '@/lib/stakeholders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stakeholder update emails (admins only).
//   GET                         settings summary, held changes waiting to be sent, recent runs
//   POST {action:'cancel',key}  drop one held change so it is never sent
//   POST {action:'preview-weekly'} who would get the weekly summary (nothing is sent)
//   POST {action:'send-weekly'}    send the weekly summary now
function admin() { const u = currentUser(); return u && u.role === 'admin' ? u : null; }

export async function GET() {
  if (!admin()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  startStakeholderUpdates();
  return NextResponse.json(suStatus(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req) {
  if (!admin()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  let b = {};
  try { b = await req.json(); } catch {}
  try {
    if (b.action === 'cancel') return NextResponse.json({ ok: cancelPending(String(b.key || '')) });
    if (b.action === 'preview-weekly') return NextResponse.json(await runWeekly({ dry: true }));
    if (b.action === 'send-weekly') return NextResponse.json(await runWeekly({ force: true }));
    if (b.action === 'preview-events') return NextResponse.json(await runEvents({ dry: true, now: Date.now() + 864e5 }));
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String((e && e.message) || e) }, { status: 500 });
  }
}
