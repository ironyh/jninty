// Minimal ZIP reader: stream-extracts a single entry from a local zip file.
// Supports stored (0) and deflate (8) entries — sufficient for DwC-A/backbone
// archives. Uses only node:zlib and node:fs.
import fs from "node:fs";
import zlib from "node:zlib";

function findEOCD(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function listEntries(zipPath) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(65557, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const eocd = findEOCD(tail);
    if (eocd < 0) throw new Error("not a zip file (no EOCD)");
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const count = tail.readUInt16LE(eocd + 10);
    const cdBuf = Buffer.alloc(Math.min(size - cdOffset, 200 * 1024 * 1024));
    fs.readSync(fd, cdBuf, 0, cdBuf.length, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cdBuf.readUInt32LE(p) !== 0x02014b50) break;
      const method = cdBuf.readUInt16LE(p + 10);
      const compSize = cdBuf.readUInt32LE(p + 20);
      const nameLen = cdBuf.readUInt16LE(p + 28);
      const extraLen = cdBuf.readUInt16LE(p + 30);
      const commentLen = cdBuf.readUInt16LE(p + 32);
      const localOffset = cdBuf.readUInt32LE(p + 42);
      const name = cdBuf.toString("utf8", p + 46, p + 46 + nameLen);
      entries.push({ name, method, compSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Extract one entry to destPath; resolves when the write completes. */
export function extractEntry(zipPath, entryName, destPath) {
  const entries = listEntries(zipPath);
  const e = entries.find((x) => x.name === entryName);
  if (!e) throw new Error(`entry not found: ${entryName}`);
  const fd = fs.openSync(zipPath, "r");
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, e.localOffset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local header");
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    const src = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + e.compSize - 1 });
    const dst = fs.createWriteStream(destPath);
    return new Promise((resolve, reject) => {
      src.on("error", reject);
      dst.on("error", reject);
      dst.on("finish", resolve);
      if (e.method === 0) src.pipe(dst);
      else if (e.method === 8) src.pipe(zlib.createInflateRaw()).pipe(dst);
      else reject(new Error(`unsupported compression method ${e.method}`));
    });
  } finally {
    fs.closeSync(fd);
  }
}
