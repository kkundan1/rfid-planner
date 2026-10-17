// Who may read and write which planner collections, enforced on the server.
import { changesSince, currentRev, deleteDoc, getDoc, listDocs, setDoc } from './db';
import { createAccount, hashPassword, newSalt, ownerId, ITER, touchSession } from './auth';
import { reschedule, holSet, taskRate, taskNeed } from './reschedule';

const ADMIN_ONLY_READ = new Set(['creds', 'pwvault', 'memberlogin', 'settings', 'requests']);
const WRITER_COLLECTIONS = new Set(['members', 'projects', 'tasks', 'updates', 'history', 'files', 'logs']);
const ADMIN_COLLECTIONS = new Set(['access', 'creds', 'pwvault', 'memberlogin', 'settings', 'skills', 'calendar', 'requests']);
const ALL = new Set([...WRITER_COLLECTIONS, ...ADMIN_COLLECTIONS]);
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

export function canRead(user, c, id) {
  if (!ALL.has(c)) return false;
  if (c === 'settings' && id === 'owner') return true;
  if (ADMIN_ONLY_READ.has(c)) return user.role === 'admin' || (c === 'creds' && id === user.id);
  return true;
}

// Projects a View only person may see (ticked in their team profile). null = all.
export function visibleProjects(user) {
  if (user.role !== 'read') return null;
  const a = getDoc('access', user.id);
  const m = a && a.memberId ? getDoc('members', a.memberId) : null;
  return new Set((m && Array.isArray(m.visibleProjects) && m.visibleProjects) || []);
}

function projectOf(c, data) {
  if (c === 'projects') return null;
  if (c === 'tasks' || c === 'files') return data.projectId;
  if (c === 'updates') return data.pid;
  return undefined;
}

// Daily log entries: the writer, admins, and the lead of the linked project may read them.
const LOG_LOCK_MS = 7 * 24 * 3600 * 1000;
function memberOf(user) {
  const a = getDoc('access', user.id);
  return a && a.memberId ? a.memberId : null;
}
export function canReadLog(user, data, mid = memberOf(user)) {
  if (!data || user.role === 'read') return false;
  if (user.role === 'admin' || data.by === user.id) return true;
  if (!data.pid || !mid) return false;
  const p = getDoc('projects', data.pid);
  return !!(p && p.owner === mid);
}

// Who may change what inside a project:
//  - admins: everything
//  - the project lead: the project, all its tasks, follow-ups and documents
//  - a task owner: their own tasks (not the owner field), subtasks under their own tasks,
//    follow-ups on their own tasks, and documents in projects where they own a task
const leadOf = (pid) => { const p = pid && getDoc('projects', pid); return p ? p.owner || '' : ''; };
export function isProjectLead(user, pid, mid = memberOf(user)) { return !!mid && !!pid && leadOf(pid) === mid; }
export function canManageDocs(user, pid) {
  if (projectFrozen(pid)) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'read') return isOwnAddedProject(user, pid);
  const mid = memberOf(user);
  if (!mid) return false;
  if (isProjectLead(user, pid, mid)) return true;
  return listDocs('tasks').some((t) => t.projectId === pid && t.assignee === mid);
}
// Closed projects: "aborted" (by the lead or an admin, with a comment) and "done" (set here when all work is done).
// Their tasks, follow-ups and documents are frozen for everyone; daily log entries are still allowed.
const isClosed = (p) => !!p && (p.status === 'done' || p.status === 'aborted');
export const projectFrozen = (pid) => isClosed(pid && getDoc('projects', pid));
const STATUS_KEYS = new Set(['status', 'closeLog', 'updatedBy', 'updatedAt', 'id']);
function sameExcept(a, b, keys) {
  const pick = (o) => { const r = {}; for (const k of Object.keys(o || {}).sort()) if (!keys.has(k) && o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k]; return JSON.stringify(r); };
  return pick(a) === pick(b);
}
function assertProjectStatus(user, op, id, data) {
  const prev = getDoc('projects', id);
  const manage = user.role === 'admin' || isProjectLead(user, id);
  const mayAbort = manage || canAbortThis(user, id);
  const log0 = (prev && Array.isArray(prev.closeLog)) ? prev.closeLog : [];
  if (op === 'delete') { if (isClosed(prev)) throw new Forbidden('Reopen the project before deleting it'); return; }
  if (!data) return;
  const log1 = Array.isArray(data.closeLog) ? data.closeLog : [];
  const added = log1.length === log0.length + 1 && JSON.stringify(log1.slice(0, log0.length)) === JSON.stringify(log0) ? log1[log1.length - 1] : null;
  const okEntry = (act) => added && added.act === act && String(added.comment || '').trim().length >= 3;
  if (isClosed(prev)) {
    // Only a reopen, by the lead or an admin, with a comment, and nothing else changed.
    if (!manage || data.status !== 'active' || !okEntry('reopened') || !sameExcept(prev, data, STATUS_KEYS)) throw new Forbidden(`This project is ${prev.status === 'done' ? 'Completed' : 'Aborted'}. The project lead or an admin must reopen it, with a comment, before it can change.`);
    return;
  }
  const st = data.status || 'planning';
  if (st === 'done' && (!prev || prev.status !== 'done')) throw new Forbidden('Completed is set automatically when every task and milestone is done');
  if (st === 'aborted') { if (!mayAbort || !okEntry('aborted')) throw new Forbidden('Only the project lead or an admin can abort a project, with a comment'); return; }
  if (JSON.stringify(log1) !== JSON.stringify(log0)) throw new Forbidden('The status history can’t be edited');
}
// Sets "done" when every task and milestone is complete; back to "active" when new or reopened work appears.
function syncCompletion(pid, user, reason) {
  const p = pid && getDoc('projects', pid);
  if (!p || p.status === 'aborted') return;
  const ts = listDocs('tasks').filter((t) => t.projectId === pid);
  const parents = new Set(ts.map((t) => t.parentId).filter(Boolean));
  const leaves = ts.filter((t) => !parents.has(t.id));
  if (!leaves.length) return;
  const all = leaves.every((t) => t.status === 'done' || (+t.progress || 0) >= 100) && ts.every((t) => (Array.isArray(t.ms) ? t.ms : []).every((x) => x.done));
  const log = Array.isArray(p.closeLog) ? p.closeLog : [];
  if (all && p.status !== 'done') setDoc('projects', pid, { ...p, status: 'done', closeLog: [...log, { act: 'completed', at: Date.now(), by: 'auto', from: p.status || 'planning' }] });
  else if (!all && p.status === 'done') setDoc('projects', pid, { ...p, status: 'active', closeLog: [...log, { act: 'reactivated', at: Date.now(), by: user.id, comment: String(reason || 'New work added').slice(0, 300), from: 'done' }] });
}

function assertProjectWrite(user, op, id, data) {
  assertProjectStatus(user, op, id, data);
  if (user.role === 'admin') return;
  if (user.role === 'read') {
    const prev = getDoc('projects', id);
    if (op === 'delete') throw new Forbidden('Only the project lead or an admin can delete projects');
    if (!prev) { if (!canAddProjects(user)) throw new Forbidden('Read-only access'); if (!memberOf(user)) throw new Forbidden('Your login isn’t linked to a team member. Ask an admin to link it before creating projects.'); return; }
    if (data && data.status === 'aborted' && prev.status !== 'aborted' && canAbortThis(user, id) && sameExcept(prev, data, STATUS_KEYS)) return; // abort only
    if (!isOwnAddedProject(user, id)) throw new Forbidden('You can change only the projects you added, while you can still see them');
    return;
  }
  const mid = memberOf(user);
  const prev = getDoc('projects', id);
  if (!prev) {
    if (op === 'delete') return;
    if (!mid) throw new Forbidden('Your login isn’t linked to a team member. Ask an admin to link it before creating projects.');
    return;
  }
  if (!isProjectLead(user, id, mid)) throw new Forbidden('Only the project lead or an admin can change this project');
}
const TRANSFER_KEYS = new Set(['assignee', 'transfer', 'transfers', 'updatedBy', 'updatedAt', 'id']);
function sameExceptTransfer(a, b) {
  const pick = (o) => { const r = {}; for (const k of Object.keys(o || {}).sort()) if (!TRANSFER_KEYS.has(k) && o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k]; return JSON.stringify(r); };
  return pick(a) === pick(b);
}
function assertTaskFrozen(user, op, id, data) {
  const prev = getDoc('tasks', id);
  for (const pid of new Set([prev && prev.projectId, data && data.projectId].filter(Boolean))) {
    const p = getDoc('projects', pid);
    if (!isClosed(p)) continue;
    if (p.status === 'done' && !prev && op !== 'delete' && data && String(data.reopenWhy || '').trim()
      && (user.role === 'admin' || isProjectLead(user, pid))) continue; // new work on a completed project
    throw new Forbidden(`This project is ${p.status === 'done' ? 'Completed' : 'Aborted'}, so its tasks are frozen. ${p.status === 'done' ? 'The project lead or an admin can add new work (with a reason) or reopen it.' : 'The project lead or an admin can reopen it.'}`);
  }
}
function assertTaskWrite(user, op, id, data) {
  assertTaskFrozen(user, op, id, data);
  if (user.role === 'admin') return;
  const mid = memberOf(user);
  if (!mid) throw new Forbidden('Your login isn’t linked to a team member. Ask an admin to link it.');
  const prev = getDoc('tasks', id);
  const pid = (prev && prev.projectId) || (data && data.projectId);
  // The person a transfer is waiting for may accept it (become the owner) or decline it, and change nothing else.
  if (prev && op !== 'delete' && data && prev.transfer && prev.transfer.status === 'pending' && prev.transfer.to === mid && !isProjectLead(user, pid, mid)) {
    if (sameExceptTransfer(prev, data) && !data.transfer && Array.isArray(data.transfers) && data.transfers.length === (prev.transfers || []).length + 1
      && (data.assignee === mid || (data.assignee || '') === (prev.assignee || ''))) return;
    if (prev.assignee !== mid) throw new Forbidden('You can accept or decline this transfer, but not change the task');
  }
  if (isProjectLead(user, pid, mid)) {
    if (prev && data && data.projectId !== prev.projectId && !isProjectLead(user, data.projectId, mid)) throw new Forbidden('You can only move tasks into projects you lead');
    return;
  }
  if (op === 'delete') throw new Forbidden('Only the project lead or an admin can delete tasks');
  if (prev) {
    if (prev.assignee !== mid) throw new Forbidden('Only the task owner, the project lead or an admin can change this task');
    if ((data.assignee || '') !== (prev.assignee || '')) throw new Forbidden('Only the project lead or an admin can change who owns a task');
    if (JSON.stringify(prev.transfer || null) !== JSON.stringify(data.transfer || null) || JSON.stringify(prev.transfers || []) !== JSON.stringify(data.transfers || [])) throw new Forbidden('Only the project lead or an admin can request a task transfer');
    if (data.projectId !== prev.projectId || (data.parentId || '') !== (prev.parentId || '')) throw new Forbidden('Only the project lead or an admin can move tasks');
    return;
  }
  const parent = data && data.parentId && getDoc('tasks', data.parentId);
  if (!parent || parent.assignee !== mid || parent.projectId !== data.projectId) throw new Forbidden('Only the project lead or an admin can add tasks here. You can add subtasks to your own tasks.');
}
function assertUpdateWrite(user, op, id, data) {
  { const prev = getDoc('updates', id); const t = getDoc('tasks', (data && data.taskId) || (prev && prev.taskId)); if (t && projectFrozen(t.projectId)) throw new Forbidden('This project is closed, so its follow-ups are frozen'); }
  if (user.role === 'admin') return;
  const prev = getDoc('updates', id);
  if (prev) { if (prev.by !== user.id) throw new Forbidden('Only the person who wrote this update or an admin can change it'); return; }
  if (op === 'delete') return;
  const t = data && getDoc('tasks', data.taskId);
  const mid = memberOf(user);
  if (!t || !mid || (t.assignee !== mid && !isProjectLead(user, t.projectId, mid))) throw new Forbidden('Only the task owner, the project lead or an admin can add follow-up updates');
}

export function readChanges(user, since) {
  const rev = currentRev();
  const vis = visibleProjects(user);
  const visKey = vis ? [...vis].sort().join(',') : '*';
  const out = [];
  const mid = memberOf(user);
  for (const ch of changesSince(since)) {
    if (!canRead(user, ch.c, ch.id)) continue;
    let data = ch.data;
    if (ch.c === 'logs') {
      if (user.role === 'read') continue;
      out.push({ c: ch.c, id: ch.id, data: data && canReadLog(user, data, mid) ? data : null });
      continue;
    }
    if (vis && data) {
      if (ch.c === 'projects' && !vis.has(ch.id)) continue;
      const pid = projectOf(ch.c, data);
      if (pid !== undefined && pid !== null && !vis.has(pid)) continue;
      if (ch.c === 'history') data = { ...data, entries: (data.entries || []).filter((e) => e.pid && vis.has(e.pid)) };
    }
    // Never send password hashes to the browser.
    if (data && ch.c === 'creds') data = { loginId: data.loginId, loginKey: data.loginKey, setAt: data.setAt, setBy: data.setBy };
    out.push({ c: ch.c, id: ch.id, data });
  }
  return { rev, visKey, changes: out };
}

class Forbidden extends Error {}
export { Forbidden };

// View only people an admin has allowed to add projects (team profile switch "Can add new projects").
function memberDocOf(user) { const mid = memberOf(user); return mid ? getDoc('members', mid) : null; }
export function canAddProjects(user) {
  if (user.role !== 'read') return false;
  const m = memberDocOf(user);
  return !!(m && m.canAddProjects);
}
// View only people an admin has allowed to abort projects they can see (switch "Can abort projects").
export function canAbortProjects(user) {
  if (user.role !== 'read') return false;
  const m = memberDocOf(user);
  return !!(m && m.canAbortProjects);
}
const canAbortThis = (user, pid) => { if (!canAbortProjects(user)) return false; const vis = visibleProjects(user); return !!(vis && vis.has(pid)); };
// A project such a person added, while it is still ticked in their visible projects.
export function isOwnAddedProject(user, pid) {
  if (!canAddProjects(user)) return false;
  const p = getDoc('projects', pid);
  const vis = visibleProjects(user);
  return !!(p && p.createdBy === user.id && vis && vis.has(pid));
}

// Team profiles are admin-only, except that every person may change their own leave.
const LEAVE_KEYS = new Set(['leave', 'bookings', 'updatedBy', 'updatedAt', 'id']);
const BK_TYPES = new Set(['routine', 'support', 'meeting', 'training', 'travel', 'other']);
// Book time ahead: [{id, from, to, hours, type, pid, note, weekly, until, by, at}]
function cleanBookings(list, user) {
  if (list == null) return undefined;
  if (!Array.isArray(list)) throw new Forbidden('Bad bookings');
  if (list.length > 300) throw new Forbidden('Too many bookings');
  return list.map((b) => {
    const from = String((b && b.from) || ''), to = String((b && b.to) || from), until = String((b && b.until) || '');
    if (!ISO.test(from) || !ISO.test(to) || to < from) throw new Forbidden('Bad booking dates');
    const hours = Number(b.hours);
    if (!(hours > 0 && hours <= 24)) throw new Forbidden('Booked hours must be between 0 and 24');
    if (b.weekly && (!ISO.test(until) || until < to)) throw new Forbidden('A weekly booking needs a “repeat until” date after its end');
    if (b.weekly && (Date.parse(to) - Date.parse(from)) / 864e5 > 6) throw new Forbidden('A weekly booking spans at most 7 days');
    return { id: String(b.id || '').slice(0, 40) || 'b' + Math.random().toString(16).slice(2, 12), from, to, hours, type: BK_TYPES.has(b.type) ? b.type : 'other',
      pid: String(b.pid || '').slice(0, 60), note: String(b.note || '').slice(0, 500), weekly: !!b.weekly, until: b.weekly ? until : '',
      by: String(b.by || user.id).slice(0, 60), at: Number(b.at) || Date.now() };
  });
}
const BK_LABEL = { routine: 'routine work', support: 'production support', meeting: 'meetings', training: 'training', travel: 'travel', other: 'other work' };
const bkEnd = (b) => (b.weekly ? b.until : b.to || b.from);
const todayIso = () => new Date(Date.now() + (Number(process.env.TZ_OFFSET_MIN) || 330) * 60000).toISOString().slice(0, 10);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function assertOwnLeave(user, op, id, data) {
  const prev = getDoc('members', id);
  if (op === 'delete' || !prev || id !== memberOf(user)) throw new Forbidden('Only admins can change team profiles');
  if (!data || !sameExcept(prev, data, LEAVE_KEYS)) throw new Forbidden('You can only change your own leave and booked time');
  const L = Array.isArray(data.leave) ? data.leave : [];
  if (L.length > 400) throw new Forbidden('Too many leave entries');
  for (const r of L) {
    if (!r || !ISO.test(String(r.from || '')) || !ISO.test(String(r.to || r.from)) || String(r.to || r.from) < r.from) throw new Forbidden('Bad leave dates');
    if (r.half && (r.to || r.from) !== r.from) throw new Forbidden('A half day covers one day only');
  }
  const key = (r) => JSON.stringify([r.from, r.to || r.from, !!r.half, r.note || '']);
  const now = new Set(L.map(key)), was = new Set((prev.leave || []).map(key)), today = todayIso();
  for (const r of prev.leave || []) if ((r.to || r.from) < today && !now.has(key(r))) throw new Forbidden('Past leave can’t be changed; ask an admin');
  for (const r of L) if (!was.has(key(r)) && r.from < today) throw new Forbidden('Leave can’t start in the past; ask an admin');
  // Booked time: new bookings start today or later; one already under way can only be cut short (not before yesterday).
  const B = data.bookings || [], P = new Map((prev.bookings || []).map((b) => [b.id, b]));
  const bkey = (b) => JSON.stringify([b.from, b.to, b.hours, b.type, b.pid, !!b.weekly, b.weekly ? b.until : '']);
  for (const b of B) {
    const o = P.get(b.id);
    if (o && bkey(o) === bkey(b)) continue;
    if (!o) { if (b.from < today) throw new Forbidden('Booked time can’t start in the past; use the Daily log for work already done'); continue; }
    if (o.from >= today) { if (b.from < today) throw new Forbidden('Booked time can’t start in the past'); continue; }
    const same = o.from === b.from && o.hours === b.hours && o.type === b.type && !!o.weekly === !!b.weekly;
    const yest = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10);
    if (!same || bkEnd(b) > bkEnd(o) || bkEnd(b) < yest) throw new Forbidden('A booking already under way can only be ended early; ask an admin');
  }
  const kept = new Set(B.map((b) => b.id));
  for (const o of prev.bookings || []) if (!kept.has(o.id) && o.from < today) throw new Forbidden('A booking already under way can only be ended early, not removed');
}

function assertWrite(user, c, id) {
  if (!ALL.has(c) || !SEG.test(id)) throw new Forbidden('Unknown collection or id');
  if (user.role === 'read') {
    if (c === 'members' && id === memberOf(user)) return; // own leave only (checked below)
    if (canAddProjects(user) || canAbortProjects(user)) {
      if (c === 'history' && id === user.id) return;
      if (c === 'projects') return;
    }
    throw new Forbidden('Read-only access');
  }
  if (user.role === 'admin') return;
  if (!WRITER_COLLECTIONS.has(c)) throw new Forbidden('Only admins can change this');
  if (c === 'history' && id !== user.id) throw new Forbidden('History entries are written by their author');
}

export function writeDoc(user, op, c, id, data) {
  // Holidays or someone's leave / working days changed: move the affected task dates.
  if ((c === 'calendar' && id === 'holidays') || c === 'members') {
    const prev = getDoc(c, id);
    writeDocInner(user, op, c, id, data);
    const now = getDoc(c, id);
    try {
      if (c === 'calendar') {
        const a = holSet(prev), b = holSet(now), added = [...b].filter((d) => !a.has(d)), removed = [...a].filter((d) => !b.has(d));
        const nm = (doc, d) => (((doc && doc.days) || []).find((x) => x.date === d) || {}).name || 'a holiday';
        const why = added.length && !removed.length ? (added.length === 1 ? `the holiday “${nm(now, added[0])}” was added` : `${added.length} holidays were added`)
          : removed.length && !added.length ? (removed.length === 1 ? `the holiday “${nm(prev, removed[0])}” was removed` : `${removed.length} holidays were removed`) : 'the holidays changed';
        if (added.length || removed.length) reschedule(user, { oldHol: a, newHol: b }, why);
      }
      else if (prev && now && ['leave', 'workDays', 'bookings', 'hoursPerDay'].some((k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(now[k] ?? null))) {
        const h = holSet(getDoc('calendar', 'holidays'));
        const k = (r) => JSON.stringify([r.from, r.to || r.from, !!r.half]);
        const A = new Set((prev.leave || []).map(k)), B = new Set((now.leave || []).map(k));
        const add = [...B].some((x) => !A.has(x)), del = [...A].some((x) => !B.has(x)), who = now.name || 'someone';
        const bk = (b) => JSON.stringify([b.from, b.to, b.hours, !!b.weekly, b.until || '']);
        const BA = new Map((prev.bookings || []).map((b) => [bk(b), b])), BB = new Map((now.bookings || []).map((b) => [bk(b), b]));
        const bAdd = [...BB.keys()].filter((x) => !BA.has(x)), bDel = [...BA.keys()].filter((x) => !BB.has(x));
        const bkName = (b) => `${+b.hours} h${b.weekly ? ' a week' : ''} of ${BK_LABEL[b.type] || 'other work'}`;
        const why = add && !del ? `${who} added leave` : del && !add ? `${who} cancelled leave` : add || del ? `${who}’s leave changed`
          : bAdd.length && !bDel.length ? `${who} booked ${bkName(BB.get(bAdd[0]))}` : bDel.length && !bAdd.length ? `${who} cancelled booked time` : bAdd.length ? `${who}’s booked time changed`
          : JSON.stringify(prev.hoursPerDay ?? null) !== JSON.stringify(now.hoursPerDay ?? null) ? `${who}’s productive hours changed` : `${who}’s working days changed`;
        reschedule(user, { oldHol: h, newHol: h, members: new Map([[id, { old: prev, now }]]) }, why);
      }
    } catch (e) { console.error('Reschedule failed:', e); }
    return;
  }
  // Daily log: other work logged on a day leaves less time for that person's tasks (or gives it back).
  if (c === 'logs') {
    const prev = getDoc('logs', id);
    writeDocInner(user, op, c, id, data);
    const now = op === 'delete' ? null : getDoc('logs', id);
    const sig = (l) => (l ? JSON.stringify([l.date, +l.hours, l.taskId || '', l.mid]) : '');
    if (sig(prev) === sig(now)) return;
    try {
      const h = holSet(getDoc('calendar', 'holidays'));
      const logsOld = new Map();
      for (const mid of new Set([prev && prev.mid, now && now.mid].filter(Boolean))) {
        const L = listDocs('logs').filter((l) => l.mid === mid && l.id !== id);
        if (prev && prev.mid === mid) L.push({ ...prev, id });
        logsOld.set(mid, L);
      }
      const m = getDoc('members', (now || prev).mid) || {}, who = m.name || 'someone';
      const d = (now || prev).date, dd = `${d.slice(8, 10)}/${d.slice(5, 7)}`;
      const why = now ? `${who} logged ${+now.hours} h${now.taskId ? '' : ' of other work'} on ${dd}` : `${who} removed a log entry for ${dd}`;
      reschedule(user, { oldHol: h, newHol: h, logsOld }, why);
    } catch (e) { console.error('Reschedule after log failed:', e); }
    return;
  }
  if (c !== 'tasks') return writeDocInner(user, op, c, id, data);
  const prev = getDoc('tasks', id);
  writeDocInner(user, op, c, id, data);
  const pids = new Set([prev && prev.projectId, data && data.projectId].filter(Boolean));
  for (const pid of pids) syncCompletion(pid, user, data && data.reopenWhy);
  // A reported delay: tasks that wait on this one move after it (and stakeholders are told).
  if (op !== 'delete' && data && Array.isArray(data.delays) && data.delays.length > ((prev && Array.isArray(prev.delays)) ? prev.delays.length : 0)) {
    try { const h = holSet(getDoc('calendar', 'holidays')); reschedule(user, { oldHol: h, newHol: h, pids: [data.projectId], roots: [id] }, `“${String(data.title || 'a task').slice(0, 60)}” was delayed`); } catch (e) { console.error('Reschedule after delay failed:', e); }
  }
}
function writeDocInner(user, op, c, id, data) {
  assertWrite(user, c, id);
  if (c === 'projects') assertProjectWrite(user, op, id, data);
  if (c === 'projects' && user.role === 'read' && op !== 'delete' && data && typeof data === 'object') {
    const prev = getDoc('projects', id);
    if (JSON.stringify(data).length > 256 * 1024) throw new Forbidden('Document too large');
    const next = { ...data, owner: prev ? prev.owner || '' : '', techSummary: prev ? prev.techSummary || '' : '', techInputs: prev ? prev.techInputs || '' : '', createdBy: prev ? prev.createdBy : user.id, createdAt: prev ? prev.createdAt : Date.now(), updatedBy: user.id, updatedAt: Date.now() };
    setDoc('projects', id, next);
    if (!prev) {
      const m = memberDocOf(user);
      const vp = Array.isArray(m.visibleProjects) ? m.visibleProjects : [];
      if (!vp.includes(id)) setDoc('members', m.id || memberOf(user), { ...m, visibleProjects: [...vp, id] });
    }
    return;
  }
  if (c === 'members' && op !== 'delete' && data && typeof data === 'object' && 'bookings' in data) data = { ...data, bookings: cleanBookings(data.bookings, user) };
  if (c === 'members' && user.role !== 'admin') assertOwnLeave(user, op, id, data);
  if (c === 'tasks') assertTaskWrite(user, op, id, data);
  if (c === 'tasks' && op !== 'delete' && data && typeof data === 'object') {
    // Remember the planned start: kept while the start isn't changed by hand, so holiday/leave shifts can be undone.
    const prev = getDoc('tasks', id);
    if (prev && data.start === prev.start) { data = { ...data, ps: prev.ps || prev.start || '' }; if (prev.calMoved && !(Array.isArray(data.delays) && data.delays.length > (prev.delays || []).length)) data.calMoved = prev.calMoved; else delete data.calMoved; }
    else { data = { ...data, ps: data.start || '' }; delete data.calMoved; }
    // Hours a day this task works (used to add up hours lost to other work): reset when its plan is changed by hand
    const planChanged = !prev || ['start', 'end', 'effort', 'effortUnit', 'assignee'].some((k) => String(prev[k] ?? '') !== String(data[k] ?? ''));
    if (planChanged) {
      try { data.rate = Math.round(taskRate(data, getDoc('members', data.assignee), holSet(getDoc('calendar', 'holidays'))) * 100) / 100; data.need = taskNeed(data, data.rate); } catch { delete data.rate; delete data.need; }
    } else { if (+prev.rate > 0) data.rate = prev.rate; else delete data.rate; if (+prev.need > 0) data.need = prev.need; else delete data.need; }
  }
  if (c === 'updates') assertUpdateWrite(user, op, id, data);
  // Documents: created only by upload; never hard-deleted; only admins archive or restore.
  if (c === 'files') {
    const prev = getDoc('files', id);
    if (!prev) throw new Forbidden('Files are added by uploading');
    if (!canManageDocs(user, prev.projectId)) throw new Forbidden('Only the project lead, task owners in this project or an admin can change its documents');
    if (op === 'delete') throw new Forbidden('Files are archived, not deleted');
    const next = { ...prev };
    for (const k of ['remarks', 'category', 'categoryOther', 'taskId']) if (k in data) next[k] = String(data[k] ?? '').slice(0, 1000);
    if ('status' in data && data.status !== prev.status) {
      if (user.role !== 'admin') throw new Forbidden('Only admins can archive or restore documents');
      if (!['current', 'archived', 'superseded'].includes(data.status)) throw new Forbidden('Bad status');
      next.status = data.status;
      next.archivedBy = data.status === 'archived' ? user.id : '';
      next.archivedAt = data.status === 'archived' ? Date.now() : 0;
    }
    next.editedBy = user.id; next.editedAt = Date.now();
    setDoc('files', id, next);
    return;
  }
  if (c === 'logs') {
    const prev = getDoc('logs', id);
    const admin = user.role === 'admin';
    if (prev && !admin) {
      if (prev.by !== user.id) throw new Forbidden('Only the writer or an admin can change a diary entry');
      if (Date.now() - (prev.createdAt || 0) > LOG_LOCK_MS) throw new Forbidden('This diary entry is locked; ask an admin');
    }
    if (op === 'delete') { if (!prev) return; deleteDoc('logs', id); return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Forbidden('Bad document');
    const hours = Number(data.hours);
    if (!(hours > 0 && hours <= 24) || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) throw new Forbidden('Bad diary entry');
    if (String(data.date) > todayIso()) throw new Forbidden('The Daily log is for work already done; use “Book time ahead” for future dates');
    const next = {};
    for (const k of ['date', 'type', 'typeOther', 'what', 'pid', 'taskId', 'result', 'plan', 'fromPlan', 'bookingId']) next[k] = String(data[k] ?? '').slice(0, 2000);
    next.hours = hours;
    if (prev) { next.by = prev.by; next.mid = prev.mid; next.createdAt = prev.createdAt; }
    else if (admin) { next.by = String(data.by || user.id); next.mid = String(data.mid || memberOf(user) || ''); next.createdAt = Date.now(); }
    else { next.by = user.id; next.mid = memberOf(user) || ''; next.createdAt = Date.now(); }
    if (!next.mid) throw new Forbidden('Your login isn’t linked to a team member');
    next.updatedAt = Date.now(); next.editedBy = user.id;
    setDoc('logs', id, next);
    return;
  }
  if (op === 'delete') {
    if (id === ownerId() && (c === 'access' || c === 'creds')) throw new Forbidden('The owner account can’t be removed');
    deleteDoc(c, id);
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Forbidden('Bad document');
  if (JSON.stringify(data).length > 256 * 1024) throw new Forbidden('Document too large');

  // The owner always stays an enabled admin.
  if (c === 'access' && id === ownerId()) data = { ...data, role: 'admin', disabled: false };

  // A login prepared for a team member becomes a real account straight away.
  if (c === 'memberlogin') {
    const member = getDoc('members', id);
    const linked = listDocs('access').find((a) => a.memberId === id);
    const loginKey = String(data.loginId || '').toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(loginKey) || String(data.pw || '').length < 8) throw new Forbidden('Bad login');
    const clash = listDocs('creds').find((x) => x.loginKey === loginKey && (!linked || x.id !== linked.id));
    if (clash) throw new Forbidden('Login ID already used');
    if (linked) {
      const salt = newSalt();
      setDoc('creds', linked.id, { loginId: data.loginId, loginKey, salt, hash: hashPassword(data.pw, salt), iter: ITER, setAt: Date.now(), setBy: user.id });
      setDoc('pwvault', linked.id, { pw: data.pw, setAt: Date.now() });
    } else {
      const uid = createAccount({ loginId: data.loginId, password: data.pw, role: (member && member.accessType) || 'write', memberId: id });
      if (member && member.accessDisabled) setDoc('access', uid, { ...getDoc('access', uid), disabled: true });
    }
    return;
  }

  // Password hashes are made in the browser with the same PBKDF2 settings; keep them as sent.
  if (c === 'creds') {
    if (!data.salt || !data.hash) {
      const prev = getDoc('creds', id);
      if (prev) data = { ...data, salt: prev.salt, hash: prev.hash, iter: prev.iter };
    }
    setDoc(c, id, data);
    if (id === user.id) touchSession(user.token);
    return;
  }
  setDoc(c, id, data);
}
