// Project documents: files are stored on disk (outside the web folder),
// their details (category, revision, remarks, who/when, status) as "files" documents.
import fs from 'fs';
import path from 'path';

export const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;

export function uploadDir() {
  const dir = process.env.UPLOAD_DIR || path.join(path.dirname(process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'planner.db')), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Allowed types, decided by extension (the browser's own type isn't trusted).
const TYPES = {
  pdf: ['application/pdf', true], png: ['image/png', true], jpg: ['image/jpeg', true], jpeg: ['image/jpeg', true],
  gif: ['image/gif', true], webp: ['image/webp', true], bmp: ['image/bmp', true], txt: ['text/plain; charset=utf-8', true],
  csv: ['text/csv; charset=utf-8', false], doc: ['application/msword', false], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', false],
  xls: ['application/vnd.ms-excel', false], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', false],
  ppt: ['application/vnd.ms-powerpoint', false], pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', false],
  zip: ['application/zip', false], rar: ['application/vnd.rar', false], '7z': ['application/x-7z-compressed', false],
  dxf: ['application/octet-stream', false], dwg: ['application/octet-stream', false], step: ['application/octet-stream', false], stp: ['application/octet-stream', false],
  iges: ['application/octet-stream', false], igs: ['application/octet-stream', false], stl: ['application/octet-stream', false],
  gbr: ['application/octet-stream', false], gerber: ['application/octet-stream', false], brd: ['application/octet-stream', false], sch: ['application/octet-stream', false],
  pcbdoc: ['application/octet-stream', false], schdoc: ['application/octet-stream', false], mp4: ['video/mp4', true], mov: ['video/quicktime', false],
  s2p: ['text/plain; charset=utf-8', true], s1p: ['text/plain; charset=utf-8', true], log: ['text/plain; charset=utf-8', true], json: ['application/json', false],
};
export function fileType(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  const t = TYPES[ext];
  return t ? { ext, mime: t[0], inline: t[1] } : null;
}
export const ALLOWED_EXT = Object.keys(TYPES);

export function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'file';
}
