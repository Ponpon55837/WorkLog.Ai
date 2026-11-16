/**
 * The size a runtime directory would download as: a tar archive of the listed entries, gzip-compressed at level 6 (the
 * level `tar -czf` uses). The archive is written by this module and streamed through Node's zlib; only the compressed
 * bytes are counted and nothing is written to disk. No external `tar` runs, so the result does not depend on the
 * platform's tar or on Windows bsdtar reading its arguments in the ANSI code page (which turned non-ASCII paths into
 * `??` and failed on the CI runners).
 *
 * The archive is ustar with a pax extended header (`path`, `linkpath`) for any name that is not short ASCII, so names
 * with spaces and non-ASCII characters are stored exactly. mtime, uid and gid are zero: the number measures content,
 * not when or by whom the runtime was built.
 */
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const GZIP_LEVEL = 6;

/** Writes `value` as a NUL-terminated octal number into `field` bytes of `header` at `offset`. */
function writeOctal(header, offset, field, value) {
  header.write(value.toString(8).padStart(field - 1, "0") + "\0", offset, field, "ascii");
}

/** True when `name` fits a plain ustar name field (100 bytes) and needs no pax record. */
function fitsUstar(name) {
  return name.length < 100 && /^[\x20-\x7e]*$/.test(name);
}

/** One ustar header block. `name` and `linkname` must already fit (see fitsUstar); long names come from pax. */
function ustarHeader({ name, size, type, mode, linkname = "" }) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

/** One pax record, `<length> <key>=<value>\n`, where length counts the whole record in bytes, itself included. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body);
  let length = bodyBytes + 1;
  while (length !== bodyBytes + String(length).length) length = bodyBytes + String(length).length;
  return `${length}${body}`;
}

/** Zero bytes that pad `size` up to a whole block. */
function padding(size) {
  const rest = size % BLOCK;
  return rest === 0 ? undefined : Buffer.alloc(BLOCK - rest);
}

/** The header blocks for one entry: a pax header when a name needs it, then the ustar header. */
function* entryHeaders(entry) {
  const records = [];
  if (!fitsUstar(entry.name)) records.push(paxRecord("path", entry.name));
  if (entry.linkname !== undefined && !fitsUstar(entry.linkname)) records.push(paxRecord("linkpath", entry.linkname));
  if (records.length > 0) {
    const pax = Buffer.from(records.join(""), "utf8");
    yield ustarHeader({ name: "PaxHeader", size: pax.length, type: "x", mode: 0o644 });
    yield pax;
    const pad = padding(pax.length);
    if (pad) yield pad;
  }
  yield ustarHeader({
    ...entry,
    name: fitsUstar(entry.name) ? entry.name : "",
    linkname: entry.linkname === undefined || fitsUstar(entry.linkname) ? entry.linkname : "",
  });
}

/**
 * The tar stream of `files` (`{ path, size }`, paths relative to `directory` with `/`) and `symlinks`
 * (`{ path, target }`), in the order given, ending with the two zero blocks. A file whose length differs from `size`
 * fails the stream, because the header would then be wrong.
 */
export async function* tarStream(directory, files, symlinks = []) {
  for (const file of files) {
    yield* entryHeaders({ name: file.path, size: file.size, type: "0", mode: 0o644 });
    let written = 0;
    for await (const chunk of createReadStream(join(directory, ...file.path.split("/")))) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== file.size) throw new Error(`${file.path} is ${written} bytes, the manifest says ${file.size}`);
    const pad = padding(file.size);
    if (pad) yield pad;
  }
  for (const link of symlinks) {
    yield* entryHeaders({ name: link.path, size: 0, type: "2", mode: 0o777, linkname: link.target });
  }
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

/** Bytes of `tarStream(directory, files, symlinks)` after gzip level 6. */
export async function compressedTarSize(directory, files, symlinks = []) {
  let bytes = 0;
  const counter = new Writable({
    write(chunk, _encoding, done) {
      bytes += chunk.length;
      done();
    },
  });
  await pipeline(Readable.from(tarStream(directory, files, symlinks)), createGzip({ level: GZIP_LEVEL }), counter);
  return bytes;
}
