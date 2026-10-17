import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { getDoc, listDocs, setDoc } from '@/lib/db';
import { uploadDir, fileType, safeName } from '@/lib/files';
import { zipStream, unzip } from '@/lib/zip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admins: download project documents (files + their details) as one ZIP, or restore them from such a ZIP.
//   GET  ?pid=<project id>   one project (omit for all projects)
//   POST multipart "file"    restore from a ZIP made by GET
//   POST JSON {records}      restore document details from a full .json backup (only where the file is on the server)
const ID = /^f[0-9a-f]{18}$/;
const KEYS = ['projectId', 'taskId', 'name', 'ext', 'size', 'sha256', 'category', 'categoryOther', 'rev', 'remarks', 'by', 'at', 'status', 'family',
  'supersededBy', 'supersededAt', 'archivedBy', 'archivedAt', 'editedBy', 'editedAt'];
const admin = () => { const u = currentUser(); return u && u.role === 'admin' ? u : null; };
const folder = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'project';

export async function GET(req) {
  if (!admin()) return new Response('Forbidden', { status: 403 });
  const pid = new URL(req.url).searchParams.get('pid') || '';
  const projects = new Map(listDocs('projects').map((p) => [p.id, p]));
  if (pid && !projects.has(pid)) return new Response('Project not found', { status: 404 });
  const dir = uploadDir();
  const all = listDocs('files').filter((f) => ID.test(f.id) && (!pid || f.projectId === pid));
  const present = all.filter((f) => fs.existsSync(path.join(dir, f.id)));
  const missing = all.filter((f) => !present.includes(f));
  const manifest = {
    app: 'RFID R&D Planner', kind: 'documents', format: 1, exportedAt: new Date().toISOString(),
    projects: Object.fromEntries([...new Set(all.map((f) => f.projectId))].map((id) => { const p = projects.get(id) || {}; return [id, { code: p.code || '', name: p.name || '' }]; })),
    files: Object.fromEntries(all.map((f) => { const { id, ...d } = f; return [id, d]; })),
    missingOnServer: missing.map((f) => f.id),
  };
  const entries = [{ name: 'manifest.json', read: () => Buffer.from(JSON.stringify(manifest, null, 1)) }];
  for (const f of present) {
    const p = projects.get(f.projectId) || {};
    entries.push({ name: `documents/${folder(p.code || f.projectId)}/${f.id}__${safeName(f.name)}`, read: () => fs.readFileSync(path.join(dir, f.id)), mtime: new Date(f.at || Date.now()) });
  }
  const p = pid ? projects.get(pid) : null;
  const fname = `RFID_Planner_documents_${p ? folder(p.code || 'project') : 'all'}_${new Date().toISOString().slice(0, 10)}.zip`;
  return new Response(zipStream(entries), {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${fname}"`, 'Cache-Control': 'no-store', 'X-Files': String(present.length), 'X-Missing': String(missing.length) },
  });
}

function clean(d) {
  const out = {};
  for (const k of KEYS) if (d && d[k] !== undefined && d[k] !== null) out[k] = typeof d[k] === 'string' ? d[k].slice(0, 2000) : d[k];
  out.name = safeName(out.name);
  return out;
}

// Adds back what is missing; never overwrites or deletes.
function restore(records, dataFor) {
  const dir = uploadDir();
  const r = { filesWritten: 0, recordsAdded: 0, alreadyHere: 0, missingFile: 0, noProject: 0, badFile: 0, skipped: 0 };
  for (const [id, raw] of Object.entries(records || {})) {
    if (!ID.test(id) || !raw || typeof raw !== 'object') { r.skipped++; continue; }
    const d = clean(raw);
    if (!fileType(d.name)) { r.skipped++; continue; }
    if (!d.projectId || !getDoc('projects', d.projectId)) { r.noProject++; continue; }
    const file = path.join(dir, id);
    let wrote = false;
    if (!fs.existsSync(file)) {
      const buf = dataFor ? dataFor(id) : null;
      if (!buf) { r.missingFile++; continue; }
      if (d.sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== d.sha256) { r.badFile++; continue; }
      fs.writeFileSync(file, buf);
      r.filesWritten++; wrote = true;
    }
    if (!getDoc('files', id)) { if (d.taskId && !getDoc('tasks', d.taskId)) d.taskId = ''; setDoc('files', id, d); r.recordsAdded++; }
    else if (!wrote) r.alreadyHere++;
  }
  return r;
}

export async function POST(req) {
  if (!admin()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const type = req.headers.get('content-type') || '';
  try {
    if (type.includes('application/json')) {
      const b = await req.json().catch(() => ({}));
      return NextResponse.json({ ok: true, ...restore(b.records, null) });
    }
    const form = await req.formData();
    const f = form.get('file');
    if (!f || typeof f !== 'object' || !('arrayBuffer' in f)) return NextResponse.json({ error: 'Choose the documents ZIP file.' }, { status: 400 });
    const entries = unzip(Buffer.from(await f.arrayBuffer()));
    const man = entries.find((e) => e.name === 'manifest.json');
    let manifest = null;
    try { manifest = man ? JSON.parse(man.data().toString('utf8')) : null; } catch { manifest = null; }
    if (!manifest || manifest.app !== 'RFID R&D Planner' || manifest.kind !== 'documents' || !manifest.files) return NextResponse.json({ error: 'This ZIP wasn’t made by “Download documents” in this planner.' }, { status: 400 });
    const byId = new Map();
    for (const e of entries) { const m = /(?:^|\/)(f[0-9a-f]{18})__/.exec(e.name); if (m) byId.set(m[1], e); }
    const res = restore(manifest.files, (id) => { const e = byId.get(id); return e ? e.data() : null; });
    return NextResponse.json({ ok: true, inZip: Object.keys(manifest.files).length, ...res });
  } catch (e) {
    return NextResponse.json({ error: String((e && e.message) || e) }, { status: 400 });
  }
}
