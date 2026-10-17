import fs from 'fs';
import path from 'path';
import { currentUser } from '@/lib/auth';
import { backupDir, NAME_RE } from '@/lib/backup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admins: download one of the automatic database backups.
export async function GET(req) {
  const user = currentUser();
  if (!user) return new Response('Signed out', { status: 401 });
  if (user.role !== 'admin') return new Response('Forbidden', { status: 403 });
  const name = new URL(req.url).searchParams.get('name') || '';
  if (!NAME_RE.test(name)) return new Response('Not found', { status: 404 });
  const file = path.join(backupDir(), name);
  if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fs.statSync(file).size),
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}
