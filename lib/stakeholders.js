// Stakeholder update emails.
//  - Event updates: milestone completed or reopened, task finished, project status changed,
//    project target date moved. Each change waits HOLD minutes; if it is undone in that time
//    nothing is sent. Changes due together go out as one email per person.
//  - Weekly summary: on the day and time set in Admin settings → Email.
// Who gets them, per project: the project lead, task owners in the project, View only people
// who have the project ticked, and (when switched on) every admin.
// Runs inside the planner server (checked every minute), so it needs no cron job.
import nodemailer from 'nodemailer';
import { getDoc, listDocs, getMeta, setMeta } from './db';

const DAY = 864e5;
export const HOLD_MIN = 10;
const tz = process.env.TZ_OFFSET_MIN ? Number(process.env.TZ_OFFSET_MIN) : 330; // IST
const localNow = () => new Date(Date.now() + tz * 60000);
const todayN = () => { const d = localNow(); return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY); };
const d2n = (s) => { if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null; const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
const fmtN = (n) => { const d = new Date(n * DAY); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const fmtD = (s) => { const n = d2n(s); return n == null ? 'not set' : fmtN(n); };
const fmtTs = (t) => { const d = new Date(t + tz * 60000); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const dow = (n) => ((n + 4) % 7 + 7) % 7; // 0 = Sunday
const isWE = (n) => { const w = dow(n); return w === 0 || w === 6; };
const workdays = (a, b) => { let c = 0; for (let n = a; n <= b && c < 5000; n++) if (!isWE(n)) c++; return c; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PSTATUS = { planning: 'Planning', active: 'Active', hold: 'On hold', done: 'Completed', aborted: 'Aborted' };
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const readJson = (k, d) => { try { const v = JSON.parse(getMeta(k) || 'null'); return v ?? d; } catch { return d; } };
const writeJson = (k, v) => setMeta(k, JSON.stringify(v));

export function suSettings() {
  const e = getDoc('settings', 'email') || {};
  return {
    events: e.suEvents !== false,
    weekly: e.suWeekly !== false,
    day: Number.isInteger(+e.suDay) && e.suDay !== '' && e.suDay != null ? +e.suDay : 1,
    time: /^\d{2}:\d{2}$/.test(e.suTime || '') ? e.suTime : '09:00',
    admins: e.suAdmins !== false,
    email: e,
    pw: (getDoc('settings', 'emailpw') || {}).pw || '',
  };
}
const senderReady = (s) => !!(s.email.fromEmail && s.email.host && s.pw);

/* ---------- what is watched ---------- */
function tasksByProject() {
  const m = new Map();
  for (const t of listDocs('tasks')) { if (!m.has(t.projectId)) m.set(t.projectId, []); m.get(t.projectId).push(t); }
  return m;
}
const taskDone = (t) => t.status === 'done' || (+t.progress || 0) >= 100;

// key -> { v: value, info } for everything that can trigger an event update.
const lvKey = (r) => [r.from, r.to || r.from, r.half ? 1 : 0, r.note || ''];
function snapshot() {
  const out = {};
  const byP = tasksByProject();
  for (const m of listDocs('members')) out[`lv|${m.id}`] = { v: JSON.stringify((m.leave || []).map(lvKey).sort()), info: { pid: '__leave' } };
  for (const p of listDocs('projects')) {
    out[`ps|${p.id}`] = { v: p.status || 'planning', info: { pid: p.id } };
    out[`pt|${p.id}`] = { v: p.target || '', info: { pid: p.id } };
    const ts = byP.get(p.id) || [];
    const parents = new Set(ts.map((t) => t.parentId).filter(Boolean));
    for (const t of ts) {
      if (!parents.has(t.id)) out[`td|${t.id}`] = { v: taskDone(t) ? '1' : '0', info: { pid: p.id, tid: t.id } };
      const tr = t.transfer && t.transfer.status === 'pending' && t.transfer.to ? t.transfer : null;
      out[`tq|${t.id}`] = { v: tr ? `${tr.to}|${tr.at}` : '', info: { pid: p.id, tid: t.id } };
      out[`as|${t.id}`] = { v: t.assignee || '', info: { pid: p.id, tid: t.id } };
      const trs = Array.isArray(t.transfers) ? t.transfers : [];
      out[`tl|${t.id}`] = { v: trs.length ? `${trs.length}|${trs[trs.length - 1].status}` : '', info: { pid: p.id, tid: t.id } };
      out[`dl|${t.id}`] = { v: String(Array.isArray(t.delays) ? t.delays.length : 0), info: { pid: p.id, tid: t.id } };
      if (p.status !== 'done' && p.status !== 'aborted' && t.start && t.end) out[`dm|${t.id}`] = { v: `${t.start}|${t.end}`, info: { pid: p.id, tid: t.id } };
      for (const x of Array.isArray(t.ms) ? t.ms : []) out[`ms|${t.id}|${x.id}`] = { v: x.done ? '1' : '0', info: { pid: p.id, tid: t.id, mid: x.id } };
    }
  }
  return out;
}

/* ---------- recipients ---------- */
function people() {
  const members = new Map(listDocs('members').map((m) => [m.id, m]));
  const ownerUid = (getDoc('settings', 'owner') || {}).userId;
  const roleOf = new Map(); // memberId -> role of their login
  for (const a of listDocs('access')) {
    if (!a.memberId) continue;
    const r = a.id === ownerUid ? 'admin' : a.disabled ? 'disabled' : a.role;
    roleOf.set(a.memberId, r);
  }
  return { members, roleOf };
}
export function recipientsFor(pid, P = people(), s = suSettings(), byP = null) {
  const p = getDoc('projects', pid);
  if (!p) return [];
  const { members, roleOf } = P;
  const out = new Map(); // email -> { name, why:Set }
  const add = (m, why) => {
    if (!m || !m.email || m.accessDisabled || roleOf.get(m.id) === 'disabled') return;
    const k = String(m.email).toLowerCase();
    if (!out.has(k)) out.set(k, { email: k, name: m.name || '', why: new Set() });
    out.get(k).why.add(why);
  };
  add(members.get(p.owner), 'Project lead');
  const ts = byP ? byP.get(pid) || [] : listDocs('tasks').filter((t) => t.projectId === pid);
  for (const t of ts) add(members.get(t.assignee), 'Task owner');
  for (const m of members.values()) {
    const ro = roleOf.get(m.id) === 'read' || (!roleOf.has(m.id) && m.accessType === 'read');
    if (ro && Array.isArray(m.visibleProjects) && m.visibleProjects.includes(pid)) add(m, 'View only');
    if (s.admins && roleOf.get(m.id) === 'admin') add(m, 'Admin');
  }
  return [...out.values()].map((r) => ({ ...r, why: [...r.why] }));
}

/* ---------- event detection with the 10-minute hold ---------- */
// Leave: tell the leads of projects where the person has open work, and admins (when switched on).
function leaveRecipients(mid) {
  const s = suSettings(), out = new Set();
  for (const p of listDocs('projects')) {
    if (p.status === 'done' || p.status === 'aborted' || !p.owner || p.owner === mid) continue;
    if (listDocs('tasks').some((t) => t.projectId === p.id && t.assignee === mid && t.status !== 'done' && (+t.progress || 0) < 100)) out.add(p.owner);
  }
  if (s.admins) { const owner = (getDoc('settings', 'owner') || {}).userId; for (const a of listDocs('access')) if (a.memberId && a.memberId !== mid && !a.disabled && (a.role === 'admin' || a.id === owner)) out.add(a.memberId); }
  return [...out];
}
function describe(key, from, to, at) {
  const [kind, a, b] = key.split('|');
  if (kind === 'dl') {
    const t = getDoc('tasks', a); if (!t || !Array.isArray(t.delays) || +to <= +from) return null;
    const CAT = { tech: 'Technical issue', supplier: 'Supplier / material', customer: 'Customer input', test: 'Testing / certification failed', resource: 'Resource unavailable', other: 'Other' };
    const L = t.delays.slice(+from || 0), owner = t.assignee && getDoc('members', t.assignee), by = (u) => { const ac = getDoc('access', u); const m = ac && ac.memberId && getDoc('members', ac.memberId); return m ? m.name : ''; };
    return { pid: t.projectId, kind: 'delay', text: L.map((x) => `<span style="color:#C8323C">⚠ <b>${esc(t.title)}</b>${owner ? ` (${esc(owner.name)})` : ''} delayed by ${x.days} working day${x.days > 1 ? 's' : ''}: end ${fmtD(x.fromEnd)} → <b>${fmtD(x.toEnd)}</b></span><br><b>${esc(x.cat === 'other' && x.catOther ? x.catOther : CAT[x.cat] || 'Other')}</b> — ${esc(x.details)}${by(x.by) ? ` <span style="color:#7A8897">(reported by ${esc(by(x.by))})</span>` : ''}`).join('<br>') };
  }
  if (kind === 'dm') {
    // Dates moved automatically (holiday / leave): only announce moves made by the planner itself
    const t = getDoc('tasks', a); if (!t || !t.calMoved || !from || !to) return null;
    if (Math.abs((t.calMoved.at || 0) - (at || Date.now())) > 5 * 60000) return null;
    const [s0, e0] = from.split('|'), [s1, e1] = to.split('|');
    const r = (x, y) => `${fmtD(x)}${y !== x ? ' – ' + fmtD(y) : ''}`;
    let warn = '';
    const par = t.parentId && getDoc('tasks', t.parentId);
    if (par && par.start && par.end) {
      const late = (d2n(e1) ?? 0) - (d2n(par.end) ?? 0), early = (d2n(par.start) ?? 0) - (d2n(s1) ?? 0);
      if (late > 0) warn += `<br><span style="color:#B7791F">⚠ Now runs ${late} day${late > 1 ? 's' : ''} past its main task “${esc(par.title)}” (ends ${fmtD(par.end)})</span>`;
      else if (early > 0) warn += `<br><span style="color:#B7791F">⚠ Now starts ${early} day${early > 1 ? 's' : ''} before its main task “${esc(par.title)}”</span>`;
    }
    const owner = t.assignee && getDoc('members', t.assignee);
    return { pid: t.projectId, kind: 'moved', reason: t.calMoved.reason || 'the calendar changed', text: `<b>${esc(t.title)}</b>${owner ? ` (${esc(owner.name)})` : ''}: ${r(s0, e0)} → <b>${r(s1, e1)}</b>${warn}` };
  }
  if (kind === 'lv') {
    const m = getDoc('members', a); if (!m) return null;
    const today = new Date(Date.now() + tz * 60000).toISOString().slice(0, 10);
    let A = [], B = []; try { A = JSON.parse(from || '[]'); B = JSON.parse(to || '[]'); } catch { return null; }
    const ks = (x) => JSON.stringify(x), was = new Set(A.map(ks)), now = new Set(B.map(ks));
    const txt = (r) => `${fmtD(r[0])}${r[1] !== r[0] ? ` – ${fmtD(r[1])}` : ''}${r[2] ? ' (½ day)' : ''}${r[3] ? ` · ${esc(r[3])}` : ''}`;
    const added = B.filter((r) => !was.has(ks(r)) && r[1] >= today), gone = A.filter((r) => !now.has(ks(r)) && r[1] >= today);
    if (!added.length && !gone.length) return null;
    const parts = [...added.map((r) => `<b>${esc(m.name)}</b> on leave ${txt(r)}`), ...gone.map((r) => `<b>${esc(m.name)}</b> cancelled leave ${txt(r)}`)];
    return { pid: '__leave', kind: 'leave', only: leaveRecipients(a), text: parts.join('<br>') };
  }
  if (kind === 'ps' || kind === 'pt') {
    const p = getDoc('projects', a); if (!p) return null;
    if (kind === 'ps') {
      const L = Array.isArray(p.closeLog) ? p.closeLog : [], last = L[L.length - 1];
      const note = last && last.comment && Date.now() - (last.at || 0) < DAY ? ` · “${esc(last.comment)}”` : '';
      const lead = to === 'done' ? 'Project completed: every task and milestone is done' : to === 'aborted' ? 'Project aborted' : from === 'done' || from === 'aborted' ? `Project reopened (was ${PSTATUS[from] || from})` : 'Project status changed';
      return { pid: a, kind: 'status', text: `${lead}: ${PSTATUS[from] || from} → <b>${PSTATUS[to] || to}</b>${note}` };
    }
    const TL = Array.isArray(p.targetLog) ? p.targetLog : [], tl = TL[TL.length - 1];
    if (tl && tl.auto && tl.to === to && Date.now() - (tl.at || 0) < DAY) return { pid: a, kind: 'target', text: `<span style="color:#C8323C">⚠ <b>Project target moved automatically</b>: ${fmtD(from)} → <b>${fmtD(to)}</b>, because ${esc(tl.reason || 'tasks were delayed')}${p.target0 && p.target0 !== from ? ` (original target ${fmtD(p.target0)})` : ''}</span>` };
    return { pid: a, kind: 'target', text: `Target finish moved: ${fmtD(from)} → <b>${fmtD(to)}</b>` };
  }
  const t = getDoc('tasks', a); if (!t) return null;
  const mName = (id) => { const m = id && getDoc('members', id); return m ? m.name : 'Unassigned'; };
  const userMember = (uid) => { const ac = uid && getDoc('access', uid); return ac && ac.memberId ? ac.memberId : null; };
  const last = Array.isArray(t.transfers) && t.transfers.length ? t.transfers[t.transfers.length - 1] : null;
  if (kind === 'tq') {
    if (to) { const [mid] = to.split('|'); const tr = t.transfer || {}; return { pid: t.projectId, kind: 'transfer-req', only: [mid], text: `Transfer request for you: <b>${esc(t.title)}</b>, now owned by ${esc(mName(t.assignee))}. Open the planner to accept or decline it.${tr.reason ? ` <span style="color:#7A8897">(${esc(tr.reason)})</span>` : ''}` }; }
    return null;
  }
  if (kind === 'tl') {
    if (last && last.status === 'declined' && to.endsWith('|declined')) { const lead = (getDoc('projects', t.projectId) || {}).owner; return { pid: t.projectId, kind: 'transfer-declined', only: [...new Set([userMember(last.by), lead].filter(Boolean))], text: `Transfer of <b>${esc(t.title)}</b> to ${esc(mName(last.to))} was declined${last.note ? `: ${esc(last.note)}` : ''}. ${esc(mName(t.assignee))} still owns it.` }; }
    return null;
  }
  if (kind === 'as') {
    if (!last || last.status !== 'accepted' || last.to !== to || Date.now() - (last.doneAt || 0) > DAY) return null;
    return { pid: t.projectId, kind: 'reassigned', text: `Task transferred: <b>${esc(t.title)}</b> from ${esc(mName(from))} to <b>${esc(mName(to))}</b>` };
  }
  if (kind === 'td') return { pid: t.projectId, kind: to === '1' ? 'task-done' : 'task-reopened', text: to === '1' ? `Task finished: <b>${esc(t.title)}</b>` : `Task reopened: <b>${esc(t.title)}</b> (now ${+t.progress || 0}%)` };
  const x = (Array.isArray(t.ms) ? t.ms : []).find((y) => y.id === b); if (!x) return null;
  const L = t.ms.length, dn = t.ms.filter((y) => y.done).length;
  if (to === '1') return { pid: t.projectId, kind: 'ms-done', text: `Milestone completed: <b>${esc(x.name)}</b> in ${esc(t.title)} · ${dn} of ${L} done (${Math.round(dn / L * 100)}%)` };
  const ro = Array.isArray(x.reopened) && x.reopened.length ? x.reopened[x.reopened.length - 1] : null;
  return { pid: t.projectId, kind: 'ms-reopened', text: `Milestone reopened: <b>${esc(x.name)}</b> in ${esc(t.title)}${ro && ro.remark ? ` · Reason: ${esc(ro.remark)}` : ''} · now ${dn} of ${L} done` };
}

// Compares the live data with what was last announced. Returns the queue of held changes.
function scan(now = Date.now()) {
  const cur = snapshot();
  let base = readJson('su_base', null);
  const pending = readJson('su_pending', {});
  if (!base) { // first run: remember the current state, announce nothing
    base = {}; for (const [k, x] of Object.entries(cur)) base[k] = x.v;
    writeJson('su_base', base); writeJson('su_pending', {});
    return { base, pending: {}, cur };
  }
  let changed = false;
  for (const k of Object.keys(base)) if (!(k in cur)) { delete base[k]; delete pending[k]; changed = true; }
  for (const [k, x] of Object.entries(cur)) {
    if (!(k in base)) { base[k] = x.v; changed = true; continue; } // new item: nothing to announce
    if (x.v === base[k]) { if (pending[k]) { delete pending[k]; changed = true; } continue; } // undone in time
    if (!pending[k] || pending[k].v !== x.v) { pending[k] = { v: x.v, from: base[k], at: now, pid: x.info.pid }; changed = true; }
  }
  if (changed) { writeJson('su_base', base); writeJson('su_pending', pending); }
  return { base, pending, cur };
}

export function pendingList() {
  const { pending } = scan();
  const hold = HOLD_MIN * 60000;
  return Object.entries(pending).map(([key, p]) => {
    const d = describe(key, p.from, p.v, p.at);
    const pr = p.pid === '__leave' ? { code: 'Team', name: 'Leave' } : getDoc('projects', p.pid) || {};
    return d && { key, at: p.at, sendAt: p.at + hold, project: `${pr.code || ''} · ${pr.name || ''}`, text: d.text.replace(/<[^>]+>/g, '') };
  }).filter(Boolean).sort((a, b) => a.at - b.at);
}
export function cancelPending(key) {
  const { base, pending } = scan();
  if (!pending[key]) return false;
  base[key] = pending[key].v; delete pending[key];
  writeJson('su_base', base); writeJson('su_pending', pending);
  logRun({ type: 'cancelled', note: key });
  return true;
}

/* ---------- email ---------- */
function transportFor(s) {
  return nodemailer.createTransport({
    host: s.email.host, port: Number(s.email.port) || (s.email.security === 'ssl' ? 465 : 587),
    secure: s.email.security === 'ssl', requireTLS: s.email.security === 'starttls',
    auth: { user: s.email.user || s.email.fromEmail, pass: s.pw },
  });
}
function shell(eyebrow, title, intro, body, link, why) {
  return `<div style="font-family:Arial,sans-serif;color:#152030;max-width:680px">
  <div style="border-left:5px solid #2747C9;padding:4px 14px;margin-bottom:14px"><div style="font-size:12px;color:#7A8897;letter-spacing:.06em">RFID R&amp;D PLANNER · ${esc(eyebrow)}</div><div style="font-size:20px;font-weight:bold">${esc(title)}</div></div>
  <p style="font-size:14px">${intro}</p>${body}
  ${link ? `<p style="margin-top:18px"><a href="${esc(link)}" style="background:#2747C9;color:#fff;padding:9px 16px;border-radius:7px;text-decoration:none">Open the planner</a></p>` : ''}
  <p style="font-size:12px;color:#7A8897">${why}</p></div>`;
}
const projHead = (p) => `<div style="margin:16px 0 6px;font-size:15px"><b>${esc(p.code || '')}</b> · ${esc(p.name || '')} <span style="color:#7A8897;font-size:12px">${esc(PSTATUS[p.status] || p.status || '')}</span></div>`;

function logRun(entry) {
  const log = readJson('su_log', []);
  log.unshift({ at: Date.now(), ...entry });
  writeJson('su_log', log.slice(0, 40));
}
export function suLog() { return readJson('su_log', []); }

async function deliver(s, messages) {
  const transport = transportFor(s);
  const sent = [], failed = [];
  for (const m of messages) {
    try {
      await transport.sendMail({ from: `"${(s.email.senderName || 'RFID R&D Planner').replace(/"/g, '')}" <${s.email.fromEmail}>`, replyTo: s.email.replyTo || undefined, to: m.to, subject: m.subject, html: m.html });
      sent.push(m.to);
    } catch (e) { failed.push({ to: m.to, error: String((e && e.message) || e) }); }
  }
  return { sent, failed };
}

// Sends event updates whose hold time has passed. dry = build the emails but send nothing.
export async function runEvents({ dry = false, now = Date.now() } = {}) {
  const s = suSettings();
  const { base, pending } = scan(now);
  const hold = HOLD_MIN * 60000;
  const due = Object.entries(pending).filter(([, p]) => now - p.at >= hold);
  if (!due.length) return { due: 0 };
  const consume = () => { for (const [k, p] of due) { base[k] = p.v; delete pending[k]; } writeJson('su_base', base); writeJson('su_pending', pending); };
  if (!dry && !s.events) { consume(); return { skipped: 'Event updates are switched off.' }; }
  if (!dry && !senderReady(s)) { consume(); logRun({ type: 'events', error: 'Email sender account is not set up', count: due.length }); return { error: 'Email sender account is not set up in Admin settings → Email.' }; }

  const byPid = new Map();
  for (const [k, p] of due) { const d = describe(k, p.from, p.v, p.at); if (!d) continue; if (!byPid.has(d.pid)) byPid.set(d.pid, []); byPid.get(d.pid).push(d); }
  // Automatic date moves: one heading per reason, then the tasks; add a target warning once per project
  for (const [pid, items] of byPid) {
    const mv = items.filter((d) => d.kind === 'moved'); if (!mv.length && !items.some((d) => d.kind === 'delay')) continue;
    const rest = items.filter((d) => d.kind !== 'moved'), out = [];
    for (const why of [...new Set(mv.map((d) => d.reason))]) {
      const L = mv.filter((d) => d.reason === why);
      out.push({ pid, kind: 'moved', why, text: `Dates moved automatically because ${esc(why)} — ${L.length} task${L.length > 1 ? 's' : ''}:<ul style="margin:4px 0;padding-left:18px">${L.map((d) => `<li>${d.text}</li>`).join('')}</ul>` });
    }
    const p = getDoc('projects', pid), tg = p && d2n(p.target);
    if (tg != null) { let mx = -Infinity; for (const t of listDocs('tasks')) if (t.projectId === pid && t.end) mx = Math.max(mx, d2n(t.end) ?? -Infinity); if (mx > tg) out.push({ pid, kind: 'moved', text: `<span style="color:#C8323C">⚠ Project forecast now ${mx - tg} day${mx - tg > 1 ? 's' : ''} past its target ${fmtN(tg)}</span>` }); }
    byPid.set(pid, [...rest, ...out]);
  }
  const P = people(), byP = tasksByProject();
  const per = new Map(); // email -> { name, projects: [{p, items}] }
  for (const [pid, items] of byPid) {
    const p = pid === '__leave' ? { code: 'Team', name: 'Leave', status: '' } : getDoc('projects', pid); if (!p) continue;
    const all = pid === '__leave' ? [] : recipientsFor(pid, P, s, byP);
    const add = (r, list) => { if (!list.length) return; if (!per.has(r.email)) per.set(r.email, { name: r.name, projects: [] }); const ex = per.get(r.email).projects.find((x) => x.pid === pid); if (ex) ex.items.push(...list); else per.get(r.email).projects.push({ pid, p, items: list }); };
    for (const r of all) add(r, items.filter((d) => !d.only));
    // Transfer requests and refusals go only to the people concerned.
    const direct = new Map();
    for (const d of items.filter((x) => x.only)) for (const mid of new Set(d.only)) {
      const m = P.members.get(mid); if (!m || !m.email || m.accessDisabled || P.roleOf.get(mid) === 'disabled') continue;
      const k = String(m.email).toLowerCase(); if (!direct.has(k)) direct.set(k, { r: { email: k, name: m.name || '' }, list: [] }); if (!direct.get(k).list.includes(d)) direct.get(k).list.push(d);
    }
    for (const { r, list } of direct.values()) add(r, list);
  }
  const link = s.email.link || process.env.APP_URL || '';
  const messages = [];
  for (const [to, v] of per) {
    const n = v.projects.reduce((a, x) => a + x.items.length, 0);
    const body = v.projects.map(({ p, items }) => projHead(p) + `<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.6">${items.map((d) => `<li>${d.text}</li>`).join('')}</ul>`).join('');
    const first = v.projects[0];
    const dlFirst = v.projects.length === 1 && first.items.find((d) => d.kind === 'delay');
    const mvAll = !dlFirst && v.projects.every((x) => x.items.every((d) => d.kind === 'moved'));
    const subject = dlFirst ? `${first.p.code || first.p.name}: delay reported${dlFirst.text.match(/<b>([^<]+)<\/b>/) ? ' · ' + dlFirst.text.match(/<b>([^<]+)<\/b>/)[1] : ''}`
      : mvAll && v.projects.length === 1
      ? `${first.p.code || first.p.name}: task dates moved automatically${(first.items.find((d) => d.why) || {}).why ? ` (${first.items.find((d) => d.why).why})` : ''}`
      : v.projects.length === 1
      ? `${first.p.code || first.p.name}: ${n === 1 ? first.items[0].text.replace(/<[^>]+>/g, '') : `${n} project updates`}`
      : `${n} project updates in ${v.projects.length} projects`;
    messages.push({ to, subject: subject.slice(0, 150), html: shell('PROJECT UPDATE', `Hello ${v.name || ''}`.trim(), `${n === 1 ? 'An update' : `${n} updates`} on ${v.projects.length === 1 ? 'a project' : 'projects'} you are part of:`, body, link, 'You get this because you lead, own tasks in, or follow this project in the RFID R&amp;D Planner. Changes are sent 10 minutes after they are made, so quick corrections are not announced.') });
  }
  if (dry) return { dryRun: true, messages: messages.map((m) => ({ to: m.to, subject: m.subject })) };
  consume();
  const r = await deliver(s, messages);
  logRun({ type: 'events', count: due.length, sent: r.sent.length, failed: r.failed });
  return r;
}

/* ---------- weekly summary ---------- */
function projectSummary(p, ts, TODAY) {
  const parents = new Set(ts.map((t) => t.parentId).filter(Boolean));
  let dur = 0, pw = 0, done = 0, n = 0;
  const overdue = [], msDone = [], msDue = [], msLate = [];
  for (const t of ts) {
    const s = d2n(t.start), e = d2n(t.end);
    const leaf = !parents.has(t.id) || (s != null && e != null && e >= s);
    if (leaf) {
      const S0 = s ?? TODAY, E0 = Math.max(S0, e ?? S0), prog = Math.min(100, Math.max(0, +t.progress || 0)), d = Math.max(1, workdays(S0, E0));
      dur += d; pw += d * prog; n++;
      if (prog >= 100 || t.status === 'done') done++;
      else if (E0 < TODAY) overdue.push({ t, late: TODAY - E0, end: E0, prog });
    }
    for (const x of Array.isArray(t.ms) ? t.ms : []) {
      if (x.done && x.doneAt && x.doneAt >= Date.now() - 7 * DAY) msDone.push({ t, x });
      else if (!x.done && x.due) { const dn = d2n(x.due); if (dn != null && dn < TODAY) msLate.push({ t, x, dn }); else if (dn != null && dn <= TODAY + 14) msDue.push({ t, x, dn }); }
    }
  }
  return { prog: dur ? Math.round(pw / dur) : 0, done, n, overdue: overdue.sort((a, b) => b.late - a.late), msDone, msDue: msDue.sort((a, b) => a.dn - b.dn), msLate: msLate.sort((a, b) => a.dn - b.dn) };
}
function weeklyBlock(p, x) {
  const target = d2n(p.target);
  const bar = `<div style="background:#E4E9EF;border-radius:4px;height:8px;width:220px;display:inline-block;vertical-align:middle"><div style="background:#2747C9;height:8px;border-radius:4px;width:${x.prog}%"></div></div>`;
  const li = (a) => `<li>${a}</li>`;
  const sec = (title, items) => items.length ? `<div style="margin-top:6px;font-size:13px;font-weight:bold">${title}</div><ul style="margin:2px 0;padding-left:20px;font-size:13px;line-height:1.55">${items.join('')}</ul>` : '';
  return projHead(p) + `<div style="font-size:13px;color:#47576A">${bar} <b style="color:#152030">${x.prog}%</b> · ${x.done} of ${x.n} tasks done${target != null ? ` · target ${fmtN(target)}` : ''}</div>`
    + sec('Milestones completed this week', x.msDone.map(({ t, x: m }) => li(`${esc(m.name)} <span style="color:#7A8897">(${esc(t.title)}, ${fmtTs(m.doneAt).slice(0, 10)})</span>`)))
    + sec('Milestones overdue', x.msLate.map(({ t, x: m, dn }) => li(`<span style="color:#C8323C">${esc(m.name)}</span> <span style="color:#7A8897">(${esc(t.title)}, due ${fmtN(dn)})</span>`)))
    + sec('Milestones due in the next 2 weeks', x.msDue.map(({ t, x: m, dn }) => li(`${esc(m.name)} <span style="color:#7A8897">(${esc(t.title)}, due ${fmtN(dn)})</span>`)))
    + sec('Overdue tasks', x.overdue.slice(0, 10).map(({ t, late, end, prog }) => li(`<span style="color:#C8323C">${esc(t.title)}</span> <span style="color:#7A8897">· ${prog}% · ended ${fmtN(end)}, ${late} day${late > 1 ? 's' : ''} late</span>`)).concat(x.overdue.length > 10 ? [li(`…and ${x.overdue.length - 10} more`)] : []))
    + (!x.msDone.length && !x.msLate.length && !x.msDue.length && !x.overdue.length ? '<div style="font-size:13px;color:#7A8897;margin-top:4px">Nothing overdue and no milestones due soon.</div>' : '');
}

export async function runWeekly({ dry = false, force = false } = {}) {
  const s = suSettings();
  const now = localNow();
  const today = now.toISOString().slice(0, 10);
  if (!force && !dry) {
    if (!s.weekly) return { skipped: 'Weekly summary is switched off.' };
    const [hh, mm] = s.time.split(':').map(Number);
    if (now.getUTCDay() !== s.day || now.getUTCHours() * 60 + now.getUTCMinutes() < hh * 60 + mm) return { skipped: 'Not the weekly sending time yet.' };
    if (getMeta('su_weekly_last') === today) return { skipped: 'Already sent this week.' };
  }
  if (!dry && !senderReady(s)) { if (!force) setMeta('su_weekly_last', today); logRun({ type: 'weekly', error: 'Email sender account is not set up' }); return { error: 'Email sender account is not set up in Admin settings → Email.' }; }
  const TODAY = todayN();
  const P = people(), byP = tasksByProject();
  const per = new Map();
  const open = listDocs('projects').filter((p) => p.status !== 'done' && p.status !== 'aborted').sort((a, b) => (+a.rank || 99) - (+b.rank || 99) || String(a.name).localeCompare(b.name));
  for (const p of open) {
    const x = projectSummary(p, byP.get(p.id) || [], TODAY);
    for (const r of recipientsFor(p.id, P, s, byP)) {
      if (!per.has(r.email)) per.set(r.email, { name: r.name, blocks: [] });
      per.get(r.email).blocks.push({ p, x });
    }
  }
  const link = s.email.link || process.env.APP_URL || '';
  const messages = [];
  for (const [to, v] of per) {
    const late = v.blocks.reduce((a, b) => a + b.x.overdue.length + b.x.msLate.length, 0);
    messages.push({
      to,
      subject: `Weekly project summary · ${fmtN(TODAY)} · ${v.blocks.length} project${v.blocks.length > 1 ? 's' : ''}${late ? ` · ${late} overdue` : ''}`,
      html: shell('WEEKLY SUMMARY', `Hello ${v.name || ''}`.trim(), `Status of the ${v.blocks.length} open project${v.blocks.length > 1 ? 's' : ''} you are part of, as of ${fmtN(TODAY)}.`, v.blocks.map((b) => weeklyBlock(b.p, b.x)).join(''), link, 'You get this weekly summary because you lead, own tasks in, or follow these projects in the RFID R&amp;D Planner.'),
    });
  }
  if (dry) return { dryRun: true, messages: messages.map((m) => ({ to: m.to, subject: m.subject })) };
  if (!force) setMeta('su_weekly_last', today);
  const r = await deliver(s, messages);
  logRun({ type: 'weekly', sent: r.sent.length, failed: r.failed, manual: !!force });
  return r;
}

export function suStatus() {
  const s = suSettings();
  return { settings: { events: s.events, weekly: s.weekly, day: s.day, time: s.time, admins: s.admins }, holdMin: HOLD_MIN, senderReady: senderReady(s), pending: pendingList(), log: suLog(), weeklyLast: getMeta('su_weekly_last') || '' };
}

// Started on the first request; checks every minute.
export function startStakeholderUpdates() {
  if (process.env.STAKEHOLDER_UPDATES === '0' || globalThis.__plannerSU) return;
  globalThis.__plannerSU = true;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await runEvents(); await runWeekly(); } catch (e) { console.error('Stakeholder updates:', e); } finally { busy = false; }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60 * 1000).unref?.();
}
