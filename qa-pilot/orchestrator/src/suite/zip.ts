import { crc32, deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer, so a run's test suite can be handed over as one download without
 * taking on an archiving dependency for what amounts to a handful of small text files.
 *
 * Scope is deliberate: deflate or stored per entry, UTF-8 names, no encryption, no zip64.
 * That covers everything the suite bundle contains (source files and markdown, far below
 * the 4GB fields), and anything outside it should use a real library rather than grow this.
 */
export type ZipEntry = { path: string; content: string };

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
/** Bit 11: the file name is UTF-8, which is what every name here is. */
const UTF8_FLAG = 0x800;
const STORED = 0;
const DEFLATED = 8;

/** A fixed MS-DOS timestamp (1980-01-01), so the same input always produces the same archive. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function localHeader(e: Prepared): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL_SIG, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(UTF8_FLAG, 6);
  head.writeUInt16LE(e.method, 8);
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(e.crc, 14);
  head.writeUInt32LE(e.body.length, 18);
  head.writeUInt32LE(e.raw.length, 22);
  head.writeUInt16LE(e.name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, e.name]);
}

function centralHeader(e: Prepared, offset: number): Buffer {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(CENTRAL_SIG, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(UTF8_FLAG, 8);
  head.writeUInt16LE(e.method, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(e.crc, 16);
  head.writeUInt32LE(e.body.length, 20);
  head.writeUInt32LE(e.raw.length, 24);
  head.writeUInt16LE(e.name.length, 28);
  head.writeUInt16LE(0, 30);
  head.writeUInt16LE(0, 32);
  head.writeUInt16LE(0, 34);
  head.writeUInt16LE(0, 36);
  // 0o644, shifted into the high half where Unix permissions live. The shift alone overflows
  // into a negative signed int32, so it is coerced back to unsigned before it is written.
  head.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, e.name]);
}

type Prepared = { name: Buffer; raw: Buffer; body: Buffer; method: number; crc: number };

function prepare(entry: ZipEntry): Prepared {
  const raw = Buffer.from(entry.content, "utf8");
  const deflated = deflateRawSync(raw);
  // Incompressible content deflates larger than it started; storing it keeps the archive smaller.
  const useDeflate = deflated.length < raw.length;
  return {
    name: Buffer.from(entry.path, "utf8"),
    raw,
    body: useDeflate ? deflated : raw,
    method: useDeflate ? DEFLATED : STORED,
    crc: crc32(raw),
  };
}

/** Builds a ZIP archive from in-memory entries. Paths are used verbatim, so "a/b.ts" nests. */
export function zip(entries: ZipEntry[]): Buffer {
  if (entries.length === 0) throw new Error("cannot build an empty zip archive");
  const prepared = entries.map(prepare);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of prepared) {
    central.push(centralHeader(e, offset));
    const local = localHeader(e);
    chunks.push(local, e.body);
    offset += local.length + e.body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, directory, end]);
}
