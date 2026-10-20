// Emergency: create or reset an admin login from the server's command line.
//   node scripts/create-admin.mjs <loginId> <password> ["Full name"]
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';

const [loginId, password, name] = process.argv.slice(2);
if (!loginId || !password || password.length < 8) { console.error('Usage: node scripts/create-admin.mjs <loginId> <password (8+ chars)> ["Full name"]'); process.exit(1); }
const db = new Database(process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'planner.db'));
const get = (c, id) => { const r = db.prepare('SELECT data FROM docs WHERE collection=? AND id=? AND deleted=0').get(c, id); return r ? JSON.parse(r.data) : null; };
let rev = Number((db.prepare("SELECT value FROM meta WHERE key='rev'").get() || {}).value || 0);
const put = (c, id, d) => db.prepare(`INSERT INTO docs(collection,id,data,rev,deleted,updated_at) VALUES(?,?,?,?,0,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data, rev=excluded.rev, deleted=0, updated_at=excluded.updated_at`).run(c, id, JSON.stringify(d), ++rev, Date.now());
const key = loginId.toLowerCase();
const existing = db.prepare("SELECT id, data FROM docs WHERE collection='creds' AND deleted=0").all().find((r) => JSON.parse(r.data).loginKey === key);
const uid = existing ? existing.id : 'u_' + crypto.randomBytes(6).toString('hex');
const salt = crypto.randomBytes(16).toString('base64');
const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, 'base64'), 150000, 32, 'sha256').toString('base64');
db.transaction(() => {
  put('creds', uid, { loginId, loginKey: key, salt, hash, iter: 150000, setAt: Date.now(), setBy: uid });
  put('pwvault', uid, { pw: password, setAt: Date.now() });
  const a = get('access', uid) || { memberId: '', grantedAt: Date.now(), grantedBy: uid };
  if (!a.memberId && name) { const mid = 'm' + crypto.randomBytes(6).toString('hex'); put('members', mid, { name, role: 'Admin', hue: 0, order: Date.now() }); a.memberId = mid; }
  put('access', uid, { ...a, role: 'admin', disabled: false });
  if (!get('settings', 'owner')) put('settings', 'owner', { userId: uid });
  db.prepare("INSERT INTO meta(key,value) VALUES('rev',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(rev));
})();
console.log(`${existing ? 'Reset' : 'Created'} admin login "${loginId}".`);
