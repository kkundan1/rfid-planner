import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { currentUser } from '@/lib/auth';
import { canManageDocs, projectFrozen } from '@/lib/store';
import { getDoc, setDoc } from '@/lib/db';
import { uploadDir, fileType, safeName, MAX_BYTES } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CATS = ['Design input', 'Customer requirement', 'Specification', 'Datasheet', 'Drawing / CAD', 'Schematic / PCB', 'Test report', 'Certificate / compliance', 'Photo', 'Meeting minutes', 'Other'];
const prev0 = (id) => (id ? getDoc('files', id) : null);
const nextRev = (r) => {
  if (!r) return 'A';
  if (/^[A-Y]$/.test(r)) return String.fromCharCode(r.charCodeAt(0) + 1);
  const n = String(r).match(/(\d+)$/);
  return n ? String(r).replace(/\d+$/, String(Number(n[1]) + 1)) : r + '.1';
};

// Upload one or more files to a project (Read & write and Admin users).
export async function POST(req) {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: 'Signed out' }, { status: 401 });
  let form;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: 'Upload failed. Try again.' }, { status: 400 }); }
  const projectId = String(form.get('projectId') || '');
  const taskId = String(form.get('taskId') || '');
  const category = CATS.includes(form.get('category')) ? form.get('category') : 'Other';
  const remarks = String(form.get('remarks') || '').trim().slice(0, 1000);
  const categoryOther = String(form.get('categoryOther') || '').trim().slice(0, 60);
  const replaces = String(form.get('replaces') || '');
  let rev = String(form.get('rev') || '').trim().slice(0, 12);
  if (!getDoc('projects', projectId)) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  if (projectFrozen(projectId)) return NextResponse.json({ error: 'This project is closed (Completed or Aborted), so its documents are frozen.' }, { status: 403 });
  if (!canManageDocs(user, projectId)) return NextResponse.json({ error: 'Only the project lead, task owners in this project or an admin can upload documents here.' }, { status: 403 });
  if (taskId && !getDoc('tasks', taskId)) return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
  if (category === 'Other' && !categoryOther && !(prev0(replaces) && prev0(replaces).categoryOther)) return NextResponse.json({ error: 'Describe the “Other” category.' }, { status: 400 });
  const files = form.getAll('file').filter((f) => f && typeof f === 'object' && 'arrayBuffer' in f);
  if (!files.length) return NextResponse.json({ error: 'Choose at least one file.' }, { status: 400 });
  let prev = null;
  if (replaces) {
    prev = getDoc('files', replaces);
    if (!prev || prev.projectId !== projectId) return NextResponse.json({ error: 'The file to replace was not found.' }, { status: 404 });
    if (files.length > 1) return NextResponse.json({ error: 'Upload one file as the new revision.' }, { status: 400 });
    if (!rev) rev = nextRev(prev.rev);
  }
  for (const f of files) {
    if (!fileType(f.name)) return NextResponse.json({ error: `“${f.name}” is not an allowed file type.` }, { status: 400 });
    if (f.size > MAX_BYTES) return NextResponse.json({ error: `“${f.name}” is larger than ${Math.round(MAX_BYTES / 1048576)} MB.` }, { status: 400 });
    if (!f.size) return NextResponse.json({ error: `“${f.name}” is empty.` }, { status: 400 });
  }
  const dir = uploadDir();
  const out = [];
  for (const f of files) {
    const id = 'f' + crypto.randomBytes(9).toString('hex');
    const buf = Buffer.from(await f.arrayBuffer());
    fs.writeFileSync(path.join(dir, id), buf);
    const t = fileType(f.name);
    const doc = {
      projectId, taskId: taskId || (prev ? prev.taskId || '' : ''), name: safeName(f.name), ext: t.ext, size: f.size,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      category: prev ? (form.get('category') ? category : prev.category) : category, rev: rev || 'A', remarks,
      categoryOther: (prev && !form.get('category') ? prev.category : category) === 'Other' ? (categoryOther || (prev && prev.categoryOther) || '') : '',
      by: user.id, at: Date.now(), status: 'current', family: prev ? prev.family || prev.id : id,
    };
    setDoc('files', id, doc);
    out.push({ id, ...doc });
  }
  if (prev) setDoc('files', replaces, { ...prev, status: 'superseded', supersededBy: out[0].id, supersededAt: Date.now() });
  return NextResponse.json({ ok: true, files: out });
}
