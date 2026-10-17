// Minimal ZIP writer (stored, no compression; streams one file at a time) and reader
// (stored or deflated entries, as made by this planner, Windows or 7-Zip). No ZIP64:
// archives must stay under 4 GB and 65 535 entries.
import zlib from 'zlib';

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name, read: () => Buffer, mtime?: Date }]. Returns a web ReadableStream of the zip.
export function zipStream(entries) {
  const central = [];
  let offset = 0, i = 0, done = false;
  return new ReadableStream({
    pull(ctrl) {
      if (done) return;
      if (i < entries.length) {
        const e = entries[i++];
        const data = e.read();
        const name = Buffer.from(e.name, 'utf8');
        const crc = crc32(data);
        const { time, date } = dosTime(e.mtime || new Date());
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
        h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
        central.push({ name, crc, size: data.length, offset, time, date });
        offset += h.length + name.length + data.length;
        if (offset > 0xffffffff) throw new Error('The archive would be larger than 4 GB. Download one project at a time.');
        ctrl.enqueue(new Uint8Array(Buffer.concat([h, name, data])));
        return;
      }
      const parts = [];
      let size = 0;
      for (const c of central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(0, 10);
        h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24);
        h.writeUInt16LE(c.name.length, 28); h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36);
        h.writeUInt32LE(0, 38); h.writeUInt32LE(c.offset, 42);
        parts.push(h, c.name); size += h.length + c.name.length;
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
      parts.push(end);
      ctrl.enqueue(new Uint8Array(Buffer.concat(parts)));
      done = true;
      ctrl.close();
    },
  });
}

// Reads a whole zip held in memory. Returns [{ name, data() }].
export function unzip(buf) {
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65557); p--) if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) throw new Error('This isn’t a ZIP file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The ZIP file is damaged.');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const ln = buf.readUInt16LE(lho + 26), lx = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + ln + lx;
    out.push({
      name,
      data: () => {
        const raw = buf.slice(start, start + csize);
        if (method === 0) return raw;
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`“${name}” uses a ZIP compression this planner can’t read.`);
      },
    });
  }
  return out;
}
