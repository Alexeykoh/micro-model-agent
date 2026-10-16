/**
 * Детерминированный ZIP-писатель для тестов (не под `src/`, обычные правила тестов).
 *
 * Даёт байты spec-shaped архива: local header + central directory + EOCD.
 * Метод 0 (stored) и 8 (deflate через `zlib.deflateRawSync`). CRC32 считается
 * по-настоящему, хотя наш читатель его не проверяет, — фикстура остаётся корректной.
 */
import { deflateRawSync } from "node:zlib";

export interface ZipEntryInput {
  name: string;
  /** UTF-8 строка либо готовые байты. */
  data: string | Uint8Array;
  /** true → метод 8 (deflate); false/без поля → метод 0 (stored). */
  deflate?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 (IEEE) — spec-shaped значение для заголовков архива. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const bytesOf = (d: string | Uint8Array): Uint8Array =>
  typeof d === "string" ? new TextEncoder().encode(d) : d;

interface Prepared {
  nameBytes: number[];
  method: number;
  crc: number;
  comp: Uint8Array;
  raw: Uint8Array;
  offset: number;
}

/** Собирает ZIP-архив из записей. Все записи — одиночный диск, без zip64. */
export function buildZip(entries: ZipEntryInput[]): Uint8Array {
  const out: number[] = [];
  const prepared: Prepared[] = [];

  for (const e of entries) {
    const nameBytes = [...new TextEncoder().encode(e.name)];
    const raw = bytesOf(e.data);
    const method = e.deflate ? 8 : 0;
    const comp = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const offset = out.length;
    const crc = crc32(raw);
    prepared.push({ nameBytes, method, crc, comp, raw, offset });
    out.push(
      ...u32(0x04034b50), // local header signature
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(method),
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(crc),
      ...u32(comp.length),
      ...u32(raw.length),
      ...u16(nameBytes.length),
      ...u16(0), // extra length
      ...nameBytes,
    );
    for (const b of comp) out.push(b);
  }

  const cdOffset = out.length;
  for (const p of prepared) {
    out.push(
      ...u32(0x02014b50), // central directory signature
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(p.method),
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(p.crc),
      ...u32(p.comp.length),
      ...u32(p.raw.length),
      ...u16(p.nameBytes.length),
      ...u16(0), // extra length
      ...u16(0), // comment length
      ...u16(0), // disk start
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(p.offset),
      ...p.nameBytes,
    );
  }
  const cdSize = out.length - cdOffset;

  out.push(
    ...u32(0x06054b50), // EOCD signature
    ...u16(0), // disk number
    ...u16(0), // disk with central directory
    ...u16(prepared.length),
    ...u16(prepared.length),
    ...u32(cdSize),
    ...u32(cdOffset),
    ...u16(0), // comment length
  );

  return new Uint8Array(out);
}
