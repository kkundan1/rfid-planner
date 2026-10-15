// Connects the planner screens to this server.
// The planner was first built to run inside claude.ai, where it reached its
// database, the signed-in person and file downloads through `window.claude`.
// This file provides the same functions, backed by the Next.js API routes.

export function installShim(me) {
  const store = new Map(); // collection -> Map(id -> data)
  const listeners = new Map(); // collection -> Set(fn)
  const pending = new Map(); // "c/id" -> { c, id, data|null }
  let rev = 0;
  let loaded = false;
  let syncing = null;
  let timer = null;

  const col = (c) => {
    if (!store.has(c)) store.set(c, new Map());
    return store.get(c);
  };

  function snapshot(c) {
    const m = new Map(col(c));
    for (const p of pending.values()) {
      if (p.c !== c) continue;
      if (p.data === null) m.delete(p.id);
      else m.set(p.id, p.data);
    }
    const docs = [...m].map(([id, d]) => ({ id, exists: true, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }

  function notify(cols) {
    for (const c of cols) for (const fn of listeners.get(c) || []) {
      try { fn(snapshot(c)); } catch (e) { console.error(e); }
    }
  }

  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const r = await fetch('/api/data?since=' + rev, { cache: 'no-store' });
        if (r.status === 401) { location.href = '/login'; return; }
        if (!r.ok) return;
        const j = await r.json();
        const touched = new Set();
        for (const ch of j.changes) {
          if (ch.data === null) col(ch.c).delete(ch.id);
          else col(ch.c).set(ch.id, ch.data);
          touched.add(ch.c);
        }
        rev = j.rev;
        if (!loaded) { loaded = true; notify([...listeners.keys()]); }
        else if (touched.size) notify([...touched]);
      } catch (e) {
        /* offline: try again on the next tick */
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  function startLoop() {
    if (timer) return;
    sync();
    timer = setInterval(() => { if (!document.hidden) sync(); }, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  }

  async function write(op, c, id, data) {
    const key = c + '/' + id;
    pending.set(key, { c, id, data: op === 'delete' ? null : data });
    try {
      const r = await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, c, id, data }) });
      if (r.status === 401) { location.href = '/login'; throw { code: 'revoked', message: 'Signed out' }; }
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw { code: r.status === 403 ? 'invalid_argument' : 'unavailable', message: e.message || 'Save failed' };
      }
      await sync();
    } finally {
      pending.delete(key);
      notify([c]);
    }
  }

  const db = {
    collection(c) {
      return {
        onSnapshot(next) {
          if (!listeners.has(c)) listeners.set(c, new Set());
          listeners.get(c).add(next);
          if (loaded) setTimeout(() => next(snapshot(c)), 0);
          startLoop();
          return () => listeners.get(c).delete(next);
        },
        doc(id) {
          return {
            id,
            set: (data) => write('set', c, id, data),
            update: (data) => write('set', c, id, { ...(col(c).get(id) || {}), ...data }),
            delete: () => write('delete', c, id),
            get: async () => { await sync(); const d = col(c).get(id); return { id, exists: !!d, data: () => d }; },
          };
        },
      };
    },
    doc(path) {
      const [c, id] = path.split('/');
      return db.collection(c).doc(id);
    },
  };

  const profileCache = {};
  const user = {
    me: async () => ({ id: me.id, name: me.name, avatarUrl: '', color: '', email: null, isOwner: me.isOwner, canEdit: me.canEdit }),
    id: async () => me.id,
    isOwner: async () => me.isOwner,
    canEdit: async () => me.canEdit,
    can: async () => null,
    profiles: async (ids) => {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
      const miss = list.filter((i) => !(i in profileCache));
      if (miss.length) {
        try {
          const r = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: miss }) });
          const j = r.ok ? await r.json() : {};
          for (const i of miss) profileCache[i] = { id: i, name: (j[i] && j[i].name) || '', avatarUrl: '', color: '', email: null, isMe: i === me.id, guest: false };
        } catch { /* names show as "Someone" until the next try */ }
      }
      const out = {};
      for (const i of list) out[i] = profileCache[i] || { id: i, name: '', avatarUrl: '', color: '', email: null, isMe: i === me.id, guest: false };
      return out;
    },
    search: async (q) => {
      try {
        const r = await fetch('/api/users?q=' + encodeURIComponent(q || ''));
        return r.ok ? (await r.json()).map((x) => ({ ...x, avatarUrl: '', color: '', email: null, isMe: x.id === me.id, guest: false })) : [];
      } catch { return []; }
    },
  };

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { status: 'saved' };
    },
  };

  const caps = { db, user, downloads };
  window.claude = { use: async (name) => caps[name] || null };
}
