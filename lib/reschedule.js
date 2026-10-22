// Moves task dates when company holidays, someone's leave, their booked time ahead or their daily log
// change. Each task keeps the amount of work it needs: when other work (booked ahead, or logged on the day)
// leaves less than the task's daily hours free, the lost hours are added up and the end moves out;
// a full day lost works like a day of leave. Each task remembers its planned start (ps), so removing a holiday or leave moves the
// dates back. Tasks that wait on a moved task (finish → start) move after it. Done tasks, started
// tasks' start dates, and tasks in Completed / Aborted projects are never changed.
import { getDoc, listDocs, setDoc } from './db';

const DAY = 864e5;
const tz = Number(process.env.TZ_OFFSET_MIN) || 330;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const d2n = (s) => { if (!s || !ISO.test(s)) return null; const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
const n2d = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const dow = (n) => ((n + 4) % 7 + 7) % 7;
const todayN = () => { const d = new Date(Date.now() + tz * 60000); return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY); };
const fmt = (n) => { const d = new Date(n * DAY); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`; };

// Hours a person has booked ahead (Book time ahead) on day n; weekly bookings repeat their from–to span every 7 days
export function bookedOn(member, n, tid) {
  let h = 0;
  for (const b of (member && member.bookings) || []) {
    if (!b || !(+b.hours > 0) || b.status) continue; // waiting to be accepted, or declined: not in effect
    if (tid && b.taskId && b.taskId === tid) continue; // time booked on this task is work on it, not taken from it
    const a = d2n(b.from), z = d2n(b.to || b.from); if (a == null || z == null || n < a) continue;
    if (b.weekly) { const until = d2n(b.until) ?? z; if (n > until) continue; const off = (n - a) % 7; if (off <= z - a) h += +b.hours; }
    else if (n <= z) h += +b.hours;
  }
  return h;
}
const hpdOf = (m) => (m && +m.hoursPerDay > 0 ? +m.hoursPerDay : 6);
// A calendar for one person. work(n): a working day (weekday, no holiday, no full-day leave).
// cap(n, taskId): hours that day still free for that task: productive hours minus other work —
// on days up to today that have log entries, the hours logged on anything else; otherwise the hours booked ahead.
function cal(member, leave, hol, logs, TODAY) {
  const wd = member && Array.isArray(member.workDays) && member.workDays.length ? member.workDays.map(Number) : [1, 2, 3, 4, 5];
  const off = (leave || []).filter((r) => r && !r.half).map((r) => [d2n(r.from), d2n(r.to || r.from)]).filter((x) => x[0] != null);
  const hpd = hpdOf(member);
  const byDay = new Map();
  for (const l of logs || []) { const n = d2n(l.date); if (n == null || n > TODAY || !(+l.hours > 0)) continue; if (!byDay.has(n)) byDay.set(n, []); byDay.get(n).push(l); }
  const work = (n) => !hol.has(n2d(n)) && wd.includes(dow(n)) && !off.some(([a, b]) => n >= a && n <= b);
  const cap = (n, tid) => {
    if (!work(n)) return 0;
    const L = byDay.get(n);
    const other = L && L.length ? L.reduce((a, l) => a + (l.taskId && l.taskId === tid ? 0 : +l.hours || 0), 0) : bookedOn(member, n, tid);
    return Math.max(0, Math.min(hpd, hpd - other));
  };
  const first = (n, tid) => { let g = 0; while (cap(n, tid) <= 0 && g++ < 800) n++; return n; };
  return {
    work, cap, first, hpd,
    count: (a, b) => { let c = 0; for (let n = a; n <= b && n - a < 4000; n++) if (work(n)) c++; return c; },
    // length of [a,b] in "task days" for a task working r hours a day
    len: (a, b, r, tid) => { let d = 0; for (let n = a; n <= b && n - a < 4000; n++) d += Math.min(r, cap(n, tid)) / r; return d; },
    // the day the task finishes if it starts on s and needs D task days
    walk: (s, D, r, tid) => { let acc = 0, n = s, g = 0; while (g++ < 4000) { acc += Math.min(r, cap(n, tid)) / r; if (acc >= D - 1e-6) return n; n++; } return n; },
  };
}
// Task days of work in a task's planned dates, on its owner's calendar as it is now (holidays, leave,
// booked time, other work in the daily log). Stored on the task when its plan is set by hand.
// Outsourced jobs: the vendor works every day except Sunday; our holidays, leave, booked time and daily log don't apply.
const VCAL = (() => {
  const work = (n) => dow(n) !== 0;
  const cap = (n) => (work(n) ? 6 : 0);
  const first = (n) => { let g = 0; while (!work(n) && g++ < 10) n++; return n; };
  return {
    work, cap, first, hpd: 6,
    count: (a, b) => { let c = 0; for (let n = a; n <= b && n - a < 4000; n++) if (work(n)) c++; return c; },
    len: (a, b) => { let d = 0; for (let n = a; n <= b && n - a < 4000; n++) if (work(n)) d++; return d; },
    walk: (s, D) => { let acc = 0, n = s, g = 0; while (g++ < 4000) { if (work(n)) acc++; if (acc >= D - 1e-6) return n; n++; } return n; },
  };
})();
export function taskNeed(t, rate) {
  if (t.outsourced) { const s = d2n(t.start), e = d2n(t.end); return s == null || e == null || e < s ? 0 : Math.max(1, VCAL.count(s, e)); }
  const s = d2n(t.start), e = d2n(t.end); if (s == null || e == null || e < s) return 0;
  const m = getDoc('members', t.assignee) || null;
  const logs = listDocs('logs').filter((l) => l.mid && l.mid === t.assignee);
  const c = cal(m, m && m.leave, holSet(getDoc('calendar', 'holidays')), logs, todayN());
  const D = c.len(s, e, rate, t.id);
  return D > 0.01 ? Math.round(D * 1000) / 1000 : 1;
}
// Hours a day a task works: its effort spread over its working days (capped at the owner's productive hours);
// tasks without effort take the whole productive day.
export function taskRate(t, member, hol) {
  if (t.outsourced) return 6;
  const hpd = hpdOf(member), s = d2n(t.start), e = d2n(t.end);
  const eff = +t.effort > 0 ? (t.effortUnit === 'd' ? +t.effort * hpd : +t.effort) : 0;
  if (!eff || s == null || e == null || e < s) return hpd;
  const c = cal(member, member && member.leave, hol || new Set(), [], 0);
  return Math.max(0.25, Math.min(hpd, eff / Math.max(1, c.count(s, e))));
}
const holSet = (doc) => new Set(((doc && doc.days) || []).map((x) => x.date).filter(Boolean));

// change: { oldHol, newHol, members: Map(memberId -> { old, now }) }  (member docs before / after)
export function reschedule(user, change, reason) {
  const TODAY = todayN();
  const oldHol = change.oldHol, newHol = change.newHol;
  const memberChanged = change.members || new Map();
  const logsOld = change.logsOld || new Map(); // memberId -> that person's log entries before the change
  const projects = new Map(listDocs('projects').filter((p) => p.status !== 'done' && p.status !== 'aborted').map((p) => [p.id, p]));
  const allTasks = listDocs('tasks').filter((t) => projects.has(t.projectId));
  const holChanged = [...oldHol].some((d) => !newHol.has(d)) || [...newHol].some((d) => !oldHol.has(d));
  // Projects to recompute: all (holiday change) or those where a changed person owns tasks.
  const pids = new Set();
  for (const t of allTasks) if (holChanged || memberChanged.has(t.assignee) || logsOld.has(t.assignee)) pids.add(t.projectId);
  for (const pid of change.pids || []) if (projects.has(pid)) pids.add(pid); // e.g. a reported delay: linked tasks follow
  if (!pids.size) return 0;
  const memberDoc = new Map(listDocs('members').map((m) => [m.id, m]));
  const logsNow = new Map(); for (const l of listDocs('logs')) { if (!l.mid) continue; if (!logsNow.has(l.mid)) logsNow.set(l.mid, []); logsNow.get(l.mid).push(l); }
  const calFor = (mid, which) => {
    const ch = memberChanged.get(mid);
    const m = ch ? (which === 'old' ? ch.old : ch.now) : memberDoc.get(mid);
    const L = which === 'old' && logsOld.has(mid) ? logsOld.get(mid) : logsNow.get(mid) || [];
    return cal(m, m && m.leave, which === 'old' ? oldHol : newHol, L, TODAY);
  };
  const cache = new Map();
  const C = (mid, which) => { const k = (mid || '') + '|' + which; if (!cache.has(k)) cache.set(k, calFor(mid, which)); return cache.get(k); };
  const CT = (t, which) => (t.outsourced ? VCAL : C(t.assignee, which)); // the calendar a task runs on
  const log = new Map(); // pid -> lines
  let moved = 0;

  for (const pid of pids) {
    const ts = allTasks.filter((t) => t.projectId === pid);
    const byId = new Map(ts.map((t) => [t.id, t]));
    const kids = new Map(); for (const t of ts) if (t.parentId && byId.has(t.parentId)) { if (!kids.has(t.parentId)) kids.set(t.parentId, []); kids.get(t.parentId).push(t.id); }
    const S = new Map(), E = new Map(), was = new Map(), wdays = new Map(), rate = new Map(), active = new Set();
    for (const t of ts) {
      const s = d2n(t.start), e = d2n(t.end);
      if (s == null || e == null || e < s) continue;
      S.set(t.id, s); E.set(t.id, e); was.set(t.id, [s, e]);
      const done = t.status === 'done' || (+t.progress || 0) >= 100;
      if (done) continue;
      active.add(t.id);
      const co = CT(t, 'old'), r = +t.rate > 0 ? +t.rate : taskRate(t, memberDoc.get(t.assignee), oldHol);
      rate.set(t.id, r);
      // work the task needs, in task days: fixed when its plan was last set by hand (so repeated moves don't drift),
      // else measured on the old calendar
      const D = +t.need > 0 ? +t.need : co.len(s, e, r, t.id);
      wdays.set(t.id, D > 0.01 ? D : 1);
    }
    const walkTo = (id, ns) => { // finish day from ns; keep the old end if only zero-capacity days lie between
      const t = byId.get(id), c = CT(t, 'now'), r = rate.get(id);
      let ne = c.walk(ns, wdays.get(id), r, id); const e0 = was.get(id)[1];
      if (ne < e0) { let k = ne; while (k < e0 && c.cap(k + 1, id) <= 0) k++; if (k === e0) ne = e0; }
      return ne;
    };
    // 1) each open task from its planned start, keeping its working days
    const startMoved = new Set();
    for (const id of active) {
      const t = byId.get(id), c = CT(t, 'now'), [s] = was.get(id);
      const started = s <= TODAY;
      const ps = d2n(t.ps) ?? s;
      const ns = started ? s : c.first(Math.max(ps, TODAY + 1), id);
      const ne = walkTo(id, ns);
      if (ns !== s) startMoved.add(id);
      S.set(id, ns); E.set(id, ne);
    }
    // 2) finish → start links: a task starts after the tasks it waits on (own links and its parents' links)
    const endOf = (id, seen = new Set()) => { if (seen.has(id)) return -Infinity; seen.add(id); if (E.has(id)) return E.get(id); let m = -Infinity; for (const k of kids.get(id) || []) m = Math.max(m, endOf(k, seen)); return m; };
    const predsOf = (t) => { const out = [...(t.deps || [])]; let p = t.parentId, g = 0; while (p && byId.has(p) && g++ < 50) { out.push(...(byId.get(p).deps || [])); p = byId.get(p).parentId; } return out.filter((d) => byId.has(d) && d !== t.id); };
    const roots = new Set(change.roots || []);
    const changedEnd = (id) => { if (roots.has(id)) return true; const w = was.get(id); return w ? w[1] !== E.get(id) : false; };
    for (let pass = 0; pass < 60; pass++) {
      let ch = false;
      for (const id of active) {
        const t = byId.get(id), ps = predsOf(t); if (!ps.length) continue;
        const [s0] = was.get(id); if (s0 <= TODAY) continue; // started: don't move its start
        const touched = startMoved.has(id) || ps.some((p) => changedEnd(p) || [...(kids.get(p) || [])].some(changedEnd));
        if (!touched) continue;
        let mx = -Infinity; for (const p of ps) mx = Math.max(mx, endOf(p));
        if (!isFinite(mx) || S.get(id) > mx) continue;
        const c = CT(t, 'now'), ns = c.first(mx + 1, id);
        if (ns === S.get(id)) continue;
        S.set(id, ns); E.set(id, walkTo(id, ns)); ch = true;
      }
      if (!ch) break;
    }
    // 3) write the changes
    for (const id of active) {
      const t = byId.get(id), [s, e] = was.get(id), ns = S.get(id), ne = E.get(id);
      if (ns === s && ne === e) continue;
      const { id: _x, ...rest } = t;
      setDoc('tasks', id, { ...rest, start: n2d(ns), end: n2d(ne), ps: ISO.test(t.ps || '') ? t.ps : n2d(s), rate: +t.rate > 0 ? +t.rate : rate.get(id), need: +t.need > 0 ? +t.need : Math.round(wdays.get(id) * 1000) / 1000, calMoved: { at: Date.now(), reason: String(reason || '').slice(0, 120) } });
      moved++;
      if (!log.has(pid)) log.set(pid, []);
      log.get(pid).push(`${t.title}: ${fmt(s)}–${fmt(e)} → ${fmt(ns)}–${fmt(ne)}`);
    }
  }
  // Projects set to "move the target automatically" (the default): if the work now ends after the target, move the target
  const fresh = listDocs('tasks');
  for (const pid of pids) {
    const p = getDoc('projects', pid); if (!p || p.autoTarget === false || p.status === 'done' || p.status === 'aborted') continue;
    const tg = d2n(p.target); if (tg == null) continue;
    let mx = -Infinity; for (const t of fresh) if (t.projectId === pid) { const e = d2n(t.end); if (e != null && e > mx) mx = e; }
    if (!isFinite(mx) || mx <= tg) continue;
    const entry = { at: Date.now(), from: p.target, to: n2d(mx), reason: String(reason || '').slice(0, 120), auto: true, by: user ? user.id : '' };
    setDoc('projects', pid, { ...p, target: n2d(mx), target0: p.target0 || p.target, targetLog: [...(Array.isArray(p.targetLog) ? p.targetLog : []), entry] });
    if (!log.has(pid)) log.set(pid, []);
    log.get(pid).push(`Project target moved automatically: ${fmt(tg)} → ${fmt(mx)}`);
    moved++;
  }
  // History: one line per project, in the history of the person whose change caused it
  if (moved && user) {
    const h = getDoc('history', user.id) || { entries: [] };
    const add = [...log.entries()].map(([pid, ch]) => { const p = projects.get(pid) || {}; return { act: 'moved', kind: 'bulk', pid, code: p.code || '', title: `Dates moved automatically (${reason}): ${ch.length} task${ch.length > 1 ? 's' : ''}`, ch: ch.slice(0, 20), t: Date.now() }; });
    setDoc('history', user.id, { entries: [...add, ...(h.entries || [])].slice(0, 300) });
  }
  return moved;
}

export { holSet };
