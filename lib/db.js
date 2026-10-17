// SQLite storage: one table of JSON documents grouped by collection,
// with a global revision number so browsers can fetch only what changed.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let db;

export function dbFile() {
  return process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'planner.db');
}

export function getDb() {
  if (db) return db;
  const file = dbFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT,
      rev INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS docs_rev ON docs(rev);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires INTEGER NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sent_log (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL);
  `);
  if (!getMeta('rev')) setMeta('rev', '0');
  return db;
}

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key=?').get(key);
  return row ? row.value : null;
}
export function setMeta(key, value) {
  getDb().prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function nextRev() {
  const r = Number(getMeta('rev') || 0) + 1;
  setMeta('rev', r);
  return r;
}

export function currentRev() {
  return Number(getMeta('rev') || 0);
}

export function getDoc(collection, id) {
  const row = getDb().prepare('SELECT data FROM docs WHERE collection=? AND id=? AND deleted=0').get(collection, id);
  return row ? JSON.parse(row.data) : null;
}

export function listDocs(collection) {
  return getDb()
    .prepare('SELECT id, data FROM docs WHERE collection=? AND deleted=0')
    .all(collection)
    .map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
}

export const setDoc = (collection, id, data) =>
  getDb().transaction(() => {
    const rev = nextRev();
    getDb()
      .prepare(`INSERT INTO docs(collection,id,data,rev,deleted,updated_at) VALUES(?,?,?,?,0,?)
        ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data, rev=excluded.rev, deleted=0, updated_at=excluded.updated_at`)
      .run(collection, id, JSON.stringify(data), rev, Date.now());
    return rev;
  })();

export const deleteDoc = (collection, id) =>
  getDb().transaction(() => {
    const rev = nextRev();
    getDb()
      .prepare(`INSERT INTO docs(collection,id,data,rev,deleted,updated_at) VALUES(?,?,NULL,?,1,?)
        ON CONFLICT(collection,id) DO UPDATE SET data=NULL, rev=excluded.rev, deleted=1, updated_at=excluded.updated_at`)
      .run(collection, id, rev, Date.now());
    return rev;
  })();

export function changesSince(rev) {
  return getDb()
    .prepare('SELECT collection, id, data, deleted, rev FROM docs WHERE rev > ? ORDER BY rev')
    .all(rev)
    .map((r) => ({ c: r.collection, id: r.id, data: r.deleted ? null : JSON.parse(r.data) }));
}
