// Daily follow-up emails: finds every open task whose update is due or missed
// (same rules as the Follow-ups tab) and emails the task owner and the project lead.
import nodemailer from 'nodemailer';
import { getDb, getDoc, listDocs, getMeta, setMeta } from './db';

const DAY = 864e5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const d2n = (s) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
};
const fmt = (n) => { const d = new Date(n * DAY); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const tz = process.env.TZ_OFFSET_MIN ? Number(process.env.TZ_OFFSET_MIN) : 330; // IST
const localNow = () => new Date(Date.now() + tz * 60000);
const todayN = () => { const d = localNow(); return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY); };
const dayOf = (ts) => { const d = new Date(ts + tz * 60000); return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY); };
const FREQ = { 0: 'off', 1: 'daily', 2: 'every 2 days', 3: 'every 3 days', 4: 'every 4 days', 5: 'every 5 days', 7: 'weekly', 14: 'every 2 weeks', 21: 'every 3 weeks' };

function cfg(t, p) {
  const f = t.fu === '' || t.fu == null ? (p.fuFreq ?? 7) : +t.fu;
  let l = t.fuLead === '' || t.fuLead == null ? (p.fuLead ?? 7) : t.fuLead;
  l = l === 'off' || l === 'start' ? 'off' : +l;
  const dlf = t.fuDl === '' || t.fuDl == null ? (p.fuDl ?? 2) : +t.fuDl;
  return { f, l, dlf };
}

function state(s, e, t, p, ups, TODAY) {
  const c = cfg(t, p);
  const dlStart = c.l === 'off' || !c.dlf ? null : Math.max(s, e - c.l);
  const inDL = dlStart != null && TODAY >= dlStart;
  const lastDay = ups.length ? dayOf(ups[0].t) : null;
  let freq, next;
  if (inDL) { freq = c.dlf; next = lastDay != null && lastDay >= dlStart ? lastDay + freq : dlStart; }
  else {
    freq = c.f;
    if (!freq) return null;
    next = (lastDay != null && lastDay >= s ? lastDay : s) + freq;
    if (dlStart != null && next > dlStart) next = dlStart;
    if (TODAY < s) return null;
  }
  const late = TODAY - next;
  if (late < 0) return null;
  return { kind: late >= freq && late > 0 ? 'missed' : 'due', next, late, freq, deadlineMode: inDL };
}

export function collectDue() {
  const TODAY = todayN();
  const tasks = listDocs('tasks');
  const projects = new Map(listDocs('projects').map((p) => [p.id, p]));
  const members = new Map(listDocs('members').map((m) => [m.id, m]));
  const ups = new Map();
  for (const u of listDocs('updates')) { if (!ups.has(u.taskId)) ups.set(u.taskId, []); ups.get(u.taskId).push(u); }
  for (const a of ups.values()) a.sort((x, y) => y.t - x.t);
  const hasKids = new Set(tasks.map((t) => t.parentId).filter(Boolean));
  const items = [];
  for (const t of tasks) {
    const p = projects.get(t.projectId);
    if (!p || p.status === 'done' || p.status === 'aborted') continue;
    const s = d2n(t.start), e = d2n(t.end);
    const work = !hasKids.has(t.id) || (s != null && e != null && e >= s);
    if (!work || s == null || e == null) continue;
    const prog = +t.progress || 0;
    if (prog >= 100 || t.status === 'done') continue;
    const st = state(s, e, t, p, ups.get(t.id) || [], TODAY);
    if (!st) continue;
    items.push({ t, p, owner: members.get(t.assignee), lead: members.get(p.owner), ...st, end: e, daysLeft: e - TODAY, last: (ups.get(t.id) || [])[0] });
  }
  return { TODAY, items };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function rowHtml(x, showOwner) {
  const badge = x.kind === 'missed'
    ? `<span style="background:#C8323C;color:#fff;border-radius:10px;padding:1px 8px;font-size:12px">Missed ${x.late}d</span>`
    : `<span style="background:#B7791F;color:#fff;border-radius:10px;padding:1px 8px;font-size:12px">Update due</span>`;
  const dl = x.daysLeft < 0 ? `${-x.daysLeft} days past deadline (${fmt(x.end)})` : x.daysLeft === 0 ? 'deadline today' : `${x.daysLeft} days to deadline (${fmt(x.end)})`;
  const last = x.last ? `Last update ${fmt(dayOf(x.last.t))}: ${esc(x.last.event)} – ${esc(x.last.remarks)}` : 'No updates yet';
  return `<tr><td style="padding:8px 10px;border-top:1px solid #E4E9EF;vertical-align:top">${badge}${x.deadlineMode ? '<br><span style="font-size:11px;color:#B7791F">DEADLINE MODE</span>' : ''}</td>
  <td style="padding:8px 10px;border-top:1px solid #E4E9EF"><b>${esc(x.p.code || '')} · ${esc(x.t.title)}</b><br><span style="color:#47576A;font-size:13px">${showOwner ? esc(x.owner ? x.owner.name : 'Unassigned') + ' · ' : ''}${dl} · asked ${FREQ[x.freq] || 'every ' + x.freq + ' days'}</span><br><span style="color:#7A8897;font-size:12px">${last}</span></td></tr>`;
}

function mail(title, intro, rows, link) {
  return `<div style="font-family:Arial,sans-serif;color:#152030;max-width:640px">
  <div style="border-left:5px solid #2747C9;padding:4px 14px;margin-bottom:14px"><div style="font-size:12px;color:#7A8897;letter-spacing:.06em">RFID R&amp;D PLANNER · FOLLOW-UPS</div><div style="font-size:20px;font-weight:bold">${esc(title)}</div></div>
  <p style="font-size:14px">${intro}</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>
  <p style="margin-top:18px"><a href="${esc(link)}" style="background:#2747C9;color:#fff;padding:9px 16px;border-radius:7px;text-decoration:none">Open the planner and add an update</a></p>
  <p style="font-size:12px;color:#7A8897">You get this because a task you own or lead needs an update. Reminders stop once the task gets an update or is marked completed.</p></div>`;
}

export async function runFollowups({ force = false, dry = false } = {}) {
  getDb();
  const s = getDoc('settings', 'email') || {};
  const pw = (getDoc('settings', 'emailpw') || {}).pw || '';
  const now = localNow();
  const today = now.toISOString().slice(0, 10);
  const [hh, mm] = String(s.sendTime || '09:00').split(':').map(Number);
  const due = now.getUTCHours() * 60 + now.getUTCMinutes() >= hh * 60 + (mm || 0);
  if (!force && !dry) {
    if (s.enabled === false) return { skipped: 'Follow-up emails are switched off in Admin settings → Email.' };
    if (!due) return { skipped: `Not yet ${s.sendTime || '09:00'} IST.` };
    if (getMeta('followups_last_run') === today) return { skipped: 'Already sent today.' };
  }
  if (!dry && (!s.fromEmail || !s.host || !pw)) return { error: 'Email sender account is not set up in Admin settings → Email.' };

  const { items } = collectDue();
  const link = s.link || process.env.APP_URL || '';
  const sentKey = (to, x) => `${to}|${x.t.id}|${x.next}`;
  const seen = getDb().prepare('SELECT 1 FROM sent_log WHERE key=?');
  const byPerson = new Map(); // email -> { name, own:[], lead:[] }
  const add = (m, kind, x) => {
    if (!m || !m.email) return;
    if (!force && seen.get(sentKey(m.email, x))) return;
    if (!byPerson.has(m.email)) byPerson.set(m.email, { name: m.name, own: [], lead: [] });
    byPerson.get(m.email)[kind].push(x);
  };
  for (const x of items) {
    if (s.toOwner !== false) add(x.owner, 'own', x);
    if (s.toLead !== false && x.lead && (!x.owner || x.lead.email !== x.owner.email)) add(x.lead, 'lead', x);
  }

  const messages = [];
  for (const [to, v] of byPerson) {
    if (!v.own.length && !v.lead.length) continue;
    let rows = '';
    if (v.own.length) rows += `<tr><td colspan="2" style="padding:12px 0 4px;font-weight:bold">Your tasks</td></tr>` + v.own.map((x) => rowHtml(x, false)).join('');
    if (v.lead.length) rows += `<tr><td colspan="2" style="padding:14px 0 4px;font-weight:bold">Projects you lead</td></tr>` + v.lead.map((x) => rowHtml(x, true)).join('');
    const n = v.own.length + v.lead.length;
    const missed = [...v.own, ...v.lead].filter((x) => x.kind === 'missed').length;
    messages.push({
      to, items: [...v.own, ...v.lead],
      subject: `${missed ? `${missed} missed, ` : ''}${n} follow-up${n > 1 ? 's' : ''} need an update`,
      html: mail(`Hello ${v.name || ''}`.trim(), `${n} task${n > 1 ? 's need' : ' needs'} an update today.`, rows, link),
    });
  }
  if (dry) return { dryRun: true, messages: messages.map((m) => ({ to: m.to, subject: m.subject, tasks: m.items.map((x) => `${x.p.code || ''} ${x.t.title} (${x.kind})`) })) };

  const transport = nodemailer.createTransport({
    host: s.host, port: Number(s.port) || (s.security === 'ssl' ? 465 : 587),
    secure: s.security === 'ssl', requireTLS: s.security === 'starttls',
    auth: { user: s.user || s.fromEmail, pass: pw },
  });
  const ins = getDb().prepare('INSERT OR IGNORE INTO sent_log(key,sent_at) VALUES(?,?)');
  const sent = [], failed = [];
  for (const m of messages) {
    try {
      await transport.sendMail({ from: `"${(s.senderName || 'RFID R&D Planner').replace(/"/g, '')}" <${s.fromEmail}>`, replyTo: s.replyTo || undefined, to: m.to, subject: m.subject, html: m.html });
      for (const x of m.items) ins.run(sentKey(m.to, x), Date.now());
      sent.push(m.to);
    } catch (e) {
      failed.push({ to: m.to, error: String(e.message || e) });
    }
  }
  setMeta('followups_last_run', today);
  return { sent, failed };
}
