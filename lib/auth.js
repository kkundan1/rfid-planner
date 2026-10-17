// Logins, sessions and roles.
// Accounts are stored as planner documents so the planner's own
// "Users & access" screens manage them:
//   creds/<userId>   { loginId, loginKey, salt, hash, iter }  (PBKDF2-SHA256)
//   access/<userId>  { role: 'admin'|'write'|'read', memberId, disabled }
//   pwvault/<userId> { pw }  (admin-visible copy, as requested)
//   settings/owner   { userId }
import crypto from 'crypto';
import { cookies } from 'next/headers';
import { getDb, getDoc, listDocs, setDoc } from './db';

export const SESSION_COOKIE = 'planner_session';
const SESSION_DAYS = 7;
export const ITER = 150000;

export function hashPassword(pw, saltB64, iter = ITER) {
  return crypto.pbkdf2Sync(String(pw), Buffer.from(saltB64, 'base64'), iter, 32, 'sha256').toString('base64');
}
export function newSalt() {
  return crypto.randomBytes(16).toString('base64');
}
export function newId(prefix) {
  return prefix + crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
}

export function ownerId() {
  const o = getDoc('settings', 'owner');
  return o ? o.userId : null;
}

export function userRole(userId) {
  if (!userId) return 'none';
  const a = getDoc('access', userId);
  if (userId === ownerId()) return 'admin';
  if (!a) return 'none';
  if (a.disabled) return 'disabled';
  return ['admin', 'write', 'read'].includes(a.role) ? a.role : 'none';
}

export function userName(userId) {
  const a = getDoc('access', userId);
  if (a && a.memberId) {
    const m = getDoc('members', a.memberId);
    if (m && m.name) return m.name;
  }
  const c = getDoc('creds', userId);
  return c ? c.loginId : '';
}

export function findByLogin(loginId) {
  const key = String(loginId || '').trim().toLowerCase();
  if (!key) return null;
  return listDocs('creds').find((c) => c.loginKey === key) || null;
}

export function verifyLogin(loginId, password) {
  const c = findByLogin(loginId);
  if (!c || !c.salt || !c.hash) return null;
  const h = hashPassword(password, c.salt, c.iter || ITER);
  const a = Buffer.from(h);
  const b = Buffer.from(c.hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return c.id;
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  getDb().prepare('INSERT INTO sessions(token,user_id,expires,created) VALUES(?,?,?,?)').run(token, userId, now + SESSION_DAYS * 864e5, now);
  getDb().prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  return token;
}

export function destroySession(token) {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token=?').run(token);
}

export function touchSession(token) {
  getDb().prepare('UPDATE sessions SET created=? WHERE token=?').run(Date.now() + 1000, token);
}

export function destroyUserSessions(userId) {
  getDb().prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.INSECURE_COOKIES !== '1',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  };
}

// Returns { id, role } for the signed-in, enabled user, or null.
export function currentUser() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = getDb().prepare('SELECT user_id, expires, created FROM sessions WHERE token=?').get(token);
  if (!s || s.expires < Date.now()) return null;
  const role = userRole(s.user_id);
  if (role === 'none' || role === 'disabled') return null;
  // A password reset or removed login signs the person out everywhere.
  const c = getDoc('creds', s.user_id);
  if (!c) return null;
  if (c.setAt && c.setAt > s.created) return null;
  return { id: s.user_id, role, token };
}

export function needsSetup() {
  return !ownerId();
}

export function createAccount({ userId, loginId, password, role, memberId, name }) {
  const id = userId || newId('u_');
  const salt = newSalt();
  const now = Date.now();
  setDoc('creds', id, { loginId, loginKey: loginId.toLowerCase(), salt, hash: hashPassword(password, salt), iter: ITER, setAt: now, setBy: id });
  setDoc('pwvault', id, { pw: password, setAt: now });
  setDoc('access', id, { role, memberId: memberId || '', grantedAt: now, grantedBy: id, disabled: false });
  return id;
}
