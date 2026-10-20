import { NextResponse } from 'next/server';
import { currentUser, createAccount, ownerId, findByLogin } from '@/lib/auth';
import { deleteDoc, getDb, getDoc, listDocs, setDoc } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admins: restore a full backup (.json from “Save full backup”) exactly as it was saved.
// Planner data is written as it is in the file, so Completed / Aborted projects, their status history,
// their frozen tasks and who-created-what all come back unchanged (the everyday editing rules are for
// changes, not for putting back a saved copy). Nothing is ever deleted; items already here are kept
// unless `overwrite` is set. Logins come back from their saved passwords under the same user IDs.
//   POST { collections, overwrite } → { ok, results: { <collection>: {added, replaced, same, skipped} }, notes: [] }
const DATA = ['skills', 'calendar', 'members', 'projects', 'tasks', 'updates', 'logs'];
const SEG = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_DOC = 512 * 1024;
const same = (a, b) => { const x = { ...(a || {}) }; delete x.id; return JSON.stringify(x) === JSON.stringify(b); };
const plain = (d) => d && typeof d === 'object' && !Array.isArray(d);

export async function POST(req) {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  if (user.role !== 'admin') return NextResponse.json({ error: 'forbidden', message: 'Only admins can restore a backup' }, { status: 403 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'This isn’t a planner backup file.' }, { status: 400 }); }
  const C = body && body.collections;
  if (!plain(C)) return NextResponse.json({ error: 'This file wasn’t made by “Save full backup” in this planner.' }, { status: 400 });
  const overwrite = !!body.overwrite;
  const results = {}, notes = [];
  const R = (c) => (results[c] ||= { added: 0, replaced: 0, same: 0, skipped: 0 });

  const run = getDb().transaction(() => {
    // 1. Planner data, in an order where everything a document points at is already there.
    for (const c of DATA) {
      for (const [id, raw] of Object.entries(plain(C[c]) ? C[c] : {})) {
        const r = R(c);
        if (!SEG.test(id) || !plain(raw)) { r.skipped++; continue; }
        const d = { ...raw }; delete d.id;
        if (JSON.stringify(d).length > MAX_DOC) { r.skipped++; continue; }
        const cur = getDoc(c, id);
        if (cur && same(cur, d)) { r.same++; continue; }
        if (cur && !overwrite) { r.skipped++; continue; }
        setDoc(c, id, d); cur ? r.replaced++ : r.added++;
      }
    }
    // 2. History: each person's log comes back if it isn't here; with overwrite, entries are merged.
    for (const [id, raw] of Object.entries(plain(C.history) ? C.history : {})) {
      const r = R('history');
      if (!SEG.test(id) || !plain(raw) || !Array.isArray(raw.entries)) { r.skipped++; continue; }
      const cur = getDoc('history', id);
      if (!cur) { setDoc('history', id, { ...raw, entries: raw.entries.slice(0, 300) }); r.added++; continue; }
      if (same(cur, raw)) { r.same++; continue; }
      if (!overwrite) { r.skipped++; continue; }
      const seen = new Set((cur.entries || []).map((e) => JSON.stringify(e)));
      const merged = [...(cur.entries || []), ...raw.entries.filter((e) => !seen.has(JSON.stringify(e)))].sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 300);
      setDoc('history', id, { ...cur, entries: merged }); r.replaced++;
    }
    // 3. Logins: recreated from the saved password under the same user ID, with the saved role.
    const me = user.id, owner = ownerId();
    const acc = plain(C.access) ? C.access : {}, cr = plain(C.creds) ? C.creds : {}, pv = plain(C.pwvault) ? C.pwvault : {};
    const linked = new Set(listDocs('access').map((a) => a.memberId).filter(Boolean));
    let noPw = 0, clash = 0;
    for (const [uid, a] of Object.entries(acc)) {
      const r = R('logins');
      if (!SEG.test(uid) || !plain(a) || uid === me || uid === owner) { r.skipped++; continue; }
      const c = cr[uid], pw = pv[uid] && pv[uid].pw;
      const curA = getDoc('access', uid);
      if (curA && !overwrite) { r.same++; continue; }
      if (!c || !c.loginId || !pw) { noPw++; r.skipped++; continue; }
      const other = findByLogin(c.loginId);
      if (other && other.id === me) { r.same++; continue; } // your own login, signed in now
      if (other && other.id !== uid) { clash++; r.skipped++; continue; }
      if (!curA && a.memberId && linked.has(a.memberId)) { clash++; r.skipped++; continue; } // that person already has a login here
      createAccount({ userId: uid, loginId: String(c.loginId), password: String(pw), role: ['admin', 'write', 'read'].includes(a.role) ? a.role : 'write', memberId: a.memberId || '' });
      setDoc('access', uid, { ...getDoc('access', uid), ...a, disabled: !!a.disabled });
      if (a.memberId) linked.add(a.memberId);
      curA ? r.replaced++ : r.added++;
    }
    // Prepared logins for people who hadn't signed in yet.
    for (const [mid, ml] of Object.entries(plain(C.memberlogin) ? C.memberlogin : {})) {
      const r = R('logins');
      if (!plain(ml) || !ml.loginId || !ml.pw || !getDoc('members', mid) || linked.has(mid)) { r.skipped++; continue; }
      if (findByLogin(ml.loginId)) { clash++; r.skipped++; continue; }
      const m = getDoc('members', mid);
      createAccount({ loginId: String(ml.loginId), password: String(ml.pw), role: (m && m.accessType) || 'write', memberId: mid });
      linked.add(mid); r.added++;
    }
    // You, restoring into a fresh planner under the same login ID: link your login to your team member
    // from the backup (so you are lead of your projects again) and drop the empty one made at setup.
    const myC = getDoc('creds', me), myA = getDoc('access', me);
    const mine = myC && Object.entries(cr).find(([uid, c]) => uid !== me && c && String(c.loginId || '').toLowerCase() === myC.loginKey);
    const oldMid = mine && acc[mine[0]] && acc[mine[0]].memberId;
    if (myA && oldMid && oldMid !== myA.memberId && getDoc('members', oldMid) && !listDocs('access').some((a) => a.id !== me && a.memberId === oldMid)) {
      const setupMid = myA.memberId;
      setDoc('access', me, { ...myA, memberId: oldMid });
      const used = (id) => listDocs('projects').some((x) => [x.owner, x.salesPerson, x.assignedBy, x.createdBy].includes(id)) || listDocs('tasks').some((t) => t.assignee === id) || listDocs('logs').some((l) => l.mid === id) || listDocs('access').some((a) => a.memberId === id);
      if (setupMid && !used(setupMid)) deleteDoc('members', setupMid);
      // what your old login did (history, created by, updated by…) is now credited to your login here
      const oldUid = mine[0], q = JSON.stringify(oldUid), rq = JSON.stringify(me);
      for (const c of [...DATA, 'files']) for (const d of listDocs(c)) { const { id, ...x } = d; const j = JSON.stringify(x); if (j.includes(q)) setDoc(c, id, JSON.parse(j.split(q).join(rq))); }
      const oh = getDoc('history', oldUid);
      if (oh) { const mh = getDoc('history', me) || { entries: [] }; setDoc('history', me, { ...mh, entries: [...(mh.entries || []), ...(oh.entries || [])].sort((x, y) => (y.t || 0) - (x.t || 0)).slice(0, 300) }); deleteDoc('history', oldUid); }
      notes.push(`Your login is now linked to your team member from the backup (${(getDoc('members', oldMid) || {}).name || 'restored'})`);
    }
    if (noPw) notes.push(`${noPw} login${noPw === 1 ? '' : 's'} saved without a password: set ${noPw === 1 ? 'it' : 'them'} again in Users & access`);
    if (clash) notes.push(`${clash} login${clash === 1 ? '' : 's'} skipped because that login ID or person already has a login here`);
  });
  try { run(); } catch (e) { return NextResponse.json({ error: 'Restore failed: ' + String((e && e.message) || e) }, { status: 500 }); }
  return NextResponse.json({ ok: true, results, notes });
}
