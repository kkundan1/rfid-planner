import fs from 'fs';
import path from 'path';
import { currentUser } from '@/lib/auth';
import { visibleProjects } from '@/lib/store';
import { getDoc } from '@/lib/db';
import { uploadDir, fileType } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// View (inline) or download a project file. Any signed-in user may read.
export async function GET(req, { params }) {
  const user = currentUser();
  if (!user) return new Response('Signed out', { status: 401 });
  const id = String(params.id || '');
  if (!/^f[0-9a-f]{18}$/.test(id)) return new Response('Not found', { status: 404 });
  const meta = getDoc('files', id);
  const file = path.join(uploadDir(), id);
  if (!meta || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
  const vis = visibleProjects(user);
  if (vis && !vis.has(meta.projectId)) return new Response('Not found', { status: 404 });
  const t = fileType(meta.name) || { mime: 'application/octet-stream', inline: false };
  const download = new URL(req.url).searchParams.get('download') === '1' || !t.inline;
  const encoded = encodeURIComponent(meta.name).replace(/['()]/g, escape);
  return new Response(fs.readFileSync(file), {
    headers: {
      'Content-Type': t.mime,
      'Content-Length': String(fs.statSync(file).size),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
