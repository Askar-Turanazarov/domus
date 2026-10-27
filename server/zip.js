// Minimal ZIP reader (no dependencies): reads the central directory and unpacks stored / deflated entries.
import zlib from 'node:zlib';

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

// Entry names of the archive with their offsets; throws on a broken archive.
function listZip(buf) {
  // End of central directory: in the last 64 KB + 22 bytes (comment up to 65535).
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
  }
  if (e < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    entries.push({ name: buf.toString('utf8', p + 46, p + 46 + nlen), method, csize, size, offset });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// files: [{ name, data }]; deflate: compress the entries (method 8) instead of storing them.
function writeZip(files, { deflate = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data: raw } of files) {
    const n = Buffer.from(name), crc = crc32(raw);
    const data = deflate ? zlib.deflateRawSync(raw) : raw, method = deflate ? 8 : 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(head, n, data);
    central.push(cd, n);
    offset += 30 + n.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// Unpacked bytes of one entry (method 0 = stored, 8 = deflate); maxSize guards against zip bombs.
function readEntry(buf, entry, maxSize = 64 * 1024 * 1024) {
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC) throw new Error('bad local header');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + entry.csize);
  if (raw.length !== entry.csize) throw new Error('truncated entry');
  if (entry.size > maxSize) throw new Error('entry too large');
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: maxSize });
  throw new Error('unsupported method ' + entry.method);
}

export { listZip, readEntry, writeZip, crc32 };
