// Loads planner data from a JSON file into the database (first install or migration).
//   node scripts/import.mjs data/seed.json
// Existing documents with the same id are replaced; nothing else is removed.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const file = process.argv[2] || 'data/seed.json';
const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'planner.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
const db = new Database(dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT, rev INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (collection, id));
CREATE INDEX IF NOT EXISTS docs_rev ON docs(rev);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
let rev = Number((db.prepare("SELECT value FROM meta WHERE key='rev'").get() || {}).value || 0);
const put = db.prepare(`INSERT INTO docs(collection,id,data,rev,deleted,updated_at) VALUES(?,?,?,?,0,?)
  ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data, rev=excluded.rev, deleted=0, updated_at=excluded.updated_at`);
let n = 0;
db.transaction(() => {
  for (const [c, docs] of Object.entries(seed)) for (const [id, data] of Object.entries(docs)) { put.run(c, id, JSON.stringify(data), ++rev, Date.now()); n++; }
  db.prepare("INSERT INTO meta(key,value) VALUES('rev',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(rev));
})();
console.log(`Imported ${n} documents into ${dbPath}`);
