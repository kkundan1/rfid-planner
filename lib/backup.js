// Automatic daily backup of the database (and new uploaded documents), kept next to the database.
// Runs inside the planner server itself, so it also works on a Windows PC without cron.
import fs from 'fs';
import path from 'path';
import { dbFile, getDb, getMeta, setMeta } from './db';
import { uploadDir } from './files';

export const KEEP = Math.max(3, Number(process.env.BACKUP_KEEP || 30) || 30);
export const NAME_RE = /^planner-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/;

export function backupDir() {
  return process.env.BACKUP_DIR || path.join(path.dirname(dbFile()), 'backups');
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().reverse()
    .map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, size: st.size, at: st.mtimeMs }; });
}

let running = null;
export function runBackup(reason = 'auto') {
  if (running) return running;
  running = (async () => {
    try {
      const dir = backupDir();
      fs.mkdirSync(dir, { recursive: true });
      const name = `planner-${stamp()}.db`;
      const file = path.join(dir, name);
      await getDb().backup(file);
      const all = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort();
      for (const f of all.slice(0, Math.max(0, all.length - KEEP))) fs.unlinkSync(path.join(dir, f));
      let copied = 0;
      const up = uploadDir();
      if (fs.existsSync(up)) {
        const dst = path.join(dir, 'uploads');
        fs.mkdirSync(dst, { recursive: true });
        for (const f of fs.readdirSync(up)) if (!fs.existsSync(path.join(dst, f))) { fs.copyFileSync(path.join(up, f), path.join(dst, f)); copied++; }
      }
      const info = { name, size: fs.statSync(file).size, at: Date.now(), reason, copied };
      setMeta('lastBackup', JSON.stringify(info));
      setMeta('backupError', '');
      return info;
    } catch (e) {
      console.error('Backup failed:', e);
      setMeta('backupError', JSON.stringify({ at: Date.now(), message: String((e && e.message) || e) }));
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function backupStatus() {
  let last = null, err = null;
  try { last = JSON.parse(getMeta('lastBackup') || 'null'); } catch { /* ignore */ }
  try { err = JSON.parse(getMeta('backupError') || 'null'); } catch { /* ignore */ }
  return { dir: backupDir(), keep: KEEP, last, error: err && err.message ? `The last backup failed: ${err.message}` : null, backups: listBackups() };
}

// Started on the first request; checks every hour and backs up once per calendar day.
export function startAutoBackup() {
  if (process.env.AUTO_BACKUP === '0' || globalThis.__plannerAutoBackup) return;
  globalThis.__plannerAutoBackup = true;
  const tick = () => {
    let last = null;
    try { last = JSON.parse(getMeta('lastBackup') || 'null'); } catch { /* ignore */ }
    if (!last || localDay(last.at) !== localDay(Date.now())) runBackup('auto').catch(() => {});
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 60 * 60 * 1000).unref?.();
}
