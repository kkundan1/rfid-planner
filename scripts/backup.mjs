// Makes a consistent copy of the database into the backups folder (keeps the last 30)
// and copies any new uploaded documents (files never change once uploaded).
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const src = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'planner.db');
const dir = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const uploads = process.env.UPLOAD_DIR || path.join(path.dirname(src), 'uploads');
fs.mkdirSync(dir, { recursive: true });
const name = `planner-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`;
await new Database(src, { readonly: true }).backup(path.join(dir, name));
const files = fs.readdirSync(dir).filter((f) => f.startsWith('planner-') && f.endsWith('.db')).sort();
for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(dir, f));
let copied = 0;
if (fs.existsSync(uploads)) {
  const dst = path.join(dir, 'uploads');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(uploads)) if (!fs.existsSync(path.join(dst, f))) { fs.copyFileSync(path.join(uploads, f), path.join(dst, f)); copied++; }
}
console.log('Backup saved:', path.join(dir, name), `· ${copied} new document${copied === 1 ? '' : 's'} copied`);
