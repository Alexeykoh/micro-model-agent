/**
 * Минимальный ZIP-читатель на `node:zlib` (INV-D8: без внешних зависимостей).
 *
 * Разбирает EOCD → центральный каталог → local headers; поддерживает методы
 * сжатия 0 (stored) и 8 (deflate). CRC и zip64 не проверяются: архив читается
 * как контейнер OOXML, где целостность не является нашим контрактом. Порченый
 * ввод даёт ясную `Error` (всплывает через fail-open → `documents.error`).
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
/** Максимальная длина zip-комментария — предел обратного сканирования EOCD. */
const MAX_COMMENT = 0xffff;

/** Находит смещение EOCD, сканируя назад (комментарий архива — переменной длины). */
function findEocd(view: DataView, len: number): number {
  const floor = Math.max(0, len - EOCD_MIN - MAX_COMMENT);
  for (let pos = len - EOCD_MIN; pos >= floor; pos--) {
    if (view.getUint32(pos, true) === EOCD_SIG) return pos;
  }
  throw new Error("не ZIP-архив: не найден end-of-central-directory");
}

/** Распаковывает сжатые данные записи по методу сжатия. */
function decompress(method: number, data: Uint8Array, name: string): Uint8Array {
  if (method === 0) return data;
  if (method === 8) return new Uint8Array(inflateRawSync(data));
  throw new Error(`ZIP: неподдерживаемый метод сжатия ${method} для «${name}»`);
}

/**
 * Читает ZIP в карту «имя записи → распакованные байты».
 * @throws Error если архив не содержит валидного EOCD/каталога.
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength < EOCD_MIN) throw new Error("не ZIP-архив: файл слишком короткий");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.byteLength);
  const total = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder("utf-8");
  let pos = cdOffset;
  for (let i = 0; i < total; i++) {
    if (pos + 46 > bytes.byteLength || view.getUint32(pos, true) !== CD_SIG) {
      throw new Error("ZIP: повреждён центральный каталог");
    }
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));

    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`ZIP: повреждён local header записи «${name}»`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);

    // Пустые каталоги (внешний attr / признак каталога) пропускаем как записи без данных.
    if (!name.endsWith("/")) entries.set(name, decompress(method, data, name));
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Текст записи архива в UTF-8 или `undefined`, если записи нет. */
export function readZipText(zip: Map<string, Uint8Array>, name: string): string | undefined {
  const data = zip.get(name);
  return data ? new TextDecoder("utf-8").decode(data) : undefined;
}
