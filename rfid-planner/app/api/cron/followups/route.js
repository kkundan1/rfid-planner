import { NextResponse } from 'next/server';
import { runFollowups } from '@/lib/followups';
import { currentUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called every 15 minutes by the server's crontab (see README).
// Sends once a day, after the sending time set in Admin settings → Email.
//   POST /api/cron/followups            header x-cron-secret: <CRON_SECRET>
//   ?dry=1   preview who would get what, nothing is sent
//   ?force=1 send now, ignoring the time and "already sent today"
export async function POST(req) {
  const url = new URL(req.url);
  const secret = req.headers.get('x-cron-secret');
  const okSecret = process.env.CRON_SECRET && process.env.CRON_SECRET !== 'change-me' && secret === process.env.CRON_SECRET;
  const user = okSecret ? null : currentUser();
  if (!okSecret && !(user && user.role === 'admin')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const out = await runFollowups({ dry: url.searchParams.get('dry') === '1', force: url.searchParams.get('force') === '1' });
    return NextResponse.json(out);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
