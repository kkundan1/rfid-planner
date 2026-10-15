// Who may read and write which planner collections, enforced on the server.
import { changesSince, currentRev, deleteDoc, getDoc, listDocs, setDoc } from './db';
import { createAccount, hashPassword, newSalt, ownerId, ITER, touchSession } from './auth';

const ADMIN_ONLY_READ = new Set(['creds', 'pwvault', 'memberlogin', 'settings', 'requests']);
const WRITER_COLLECTIONS = new Set(['members', 'projects', 'tasks', 'updates', 'history']);
const ADMIN_COLLECTIONS = new Set(['access', 'creds', 'pwvault', 'memberlogin', 'settings', 'skills', 'calendar', 'requests']);
const ALL = new Set([...WRITER_COLLECTIONS, ...ADMIN_COLLECTIONS]);
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

export function canRead(user, c, id) {
  if (!ALL.has(c)) return false;
  if (c === 'settings' && id === 'owner') return true;
  if (ADMIN_ONLY_READ.has(c)) return user.role === 'admin' || (c === 'creds' && id === user.id);
  return true;
}

export function readChanges(user, since) {
  const rev = currentRev();
  const out = [];
  for (const ch of changesSince(since)) {
    if (!canRead(user, ch.c, ch.id)) continue;
    let data = ch.data;
    // Never send password hashes to the browser.
    if (data && ch.c === 'creds') data = { loginId: data.loginId, loginKey: data.loginKey, setAt: data.setAt, setBy: data.setBy };
    out.push({ c: ch.c, id: ch.id, data });
  }
  return { rev, changes: out };
}

class Forbidden extends Error {}
export { Forbidden };

function assertWrite(user, c, id) {
  if (!ALL.has(c) || !SEG.test(id)) throw new Forbidden('Unknown collection or id');
  if (user.role === 'read') throw new Forbidden('Read-only access');
  if (user.role === 'admin') return;
  if (!WRITER_COLLECTIONS.has(c)) throw new Forbidden('Only admins can change this');
  if (c === 'history' && id !== user.id) throw new Forbidden('History entries are written by their author');
}

export function writeDoc(user, op, c, id, data) {
  assertWrite(user, c, id);
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
